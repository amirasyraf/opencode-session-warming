import { errorDetails } from "./diagnostics.ts"
import type { Diagnostic } from "./diagnostics.ts"

export type Phase = "idle" | "preparing" | "generating" | "waiting" | "sending" | "stopped" | "expired"
export type Mark = { at: number; result: "sending" | "completed" | "failed" | "aborted" }
export type UsageStats = { inputTokens?: number; uncachedInputTokens?: number; cachedTokens?: number; outputTokens?: number; cacheWriteTokens?: number;
  cacheWrite5mTokens?: number; cacheWrite1hTokens?: number }
export type WarmStatus = {
  providerID?: string
  model?: string
  adapterID?: string
  strategy?: "keepalive" | "native-prewarm" | "bounded-replay"
  ttlMs?: number
  ttlEvidence?: "documented" | "upstream-assumed" | "requested"
  intervalSource?: "automatic" | "global" | "provider" | "model"
  sessionID: string
  phase: Phase
  startedAt: number
  expiresAt: number
  intervalMs: number
  durationMs: number
  nextAttemptAt?: number
  attempted: number
  completed: number
  failed: number
  usage?: UsageStats
  reason?: string
  stoppedAt?: number
  manualStopped?: boolean
  marks: Mark[]
}
/** `native` marks a location where OpenCode's built-in `warming` is configured; the plugin stays suspended there. */
export type StatusRead = { status?: WarmStatus; unavailable?: "invalid" | "read-failed" | "not-loaded"; native?: boolean }
const RETENTION_MS = 3_600_000
const MAX_SESSIONS = 64
const EMIT_DELAY_MS = 200
const safeID = (value: string) => /^[A-Za-z0-9_-]{1,128}$/.test(value)
const number = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const object = (value: unknown): value is { [key: string]: unknown } => typeof value === "object" && value !== null && !Array.isArray(value)
const usageFields = ["inputTokens", "uncachedInputTokens", "cachedTokens", "outputTokens", "cacheWriteTokens", "cacheWrite5mTokens", "cacheWrite1hTokens"] as const

function safeUsage(value: unknown): UsageStats | undefined {
  if (!object(value)) return
  const usage: UsageStats = {}
  for (const field of usageFields) if (number(value[field])) usage[field] = value[field]
  return Object.keys(usage).length ? usage : undefined
}

/** Reconstruct only allowed metadata fields; snapshots, headers, prompts, and errors never enter IPC. */
export function safeStatus(value: unknown): WarmStatus | undefined {
  if (!object(value) || typeof value.sessionID !== "string" || !safeID(value.sessionID) ||
      !["idle", "preparing", "generating", "waiting", "sending", "stopped", "expired"].includes(String(value.phase)) ||
      ![value.startedAt, value.expiresAt, value.intervalMs, value.durationMs, value.attempted, value.completed, value.failed].every(number) ||
      !value.intervalMs || !value.durationMs || (value.nextAttemptAt !== undefined && !number(value.nextAttemptAt)) ||
      (value.stoppedAt !== undefined && !number(value.stoppedAt)) ||
      !Array.isArray(value.marks) || value.marks.length > 128) return
  const marks: Mark[] = []
  for (const mark of value.marks) {
    if (!object(mark) || !number(mark.at) || !["sending", "completed", "failed", "aborted"].includes(String(mark.result))) return
    marks.push({ at: mark.at, result: mark.result as Mark["result"] })
  }
  return {
    providerID: ["openai", "github-copilot"].includes(String(value.providerID)) ? value.providerID as string : undefined,
    model: typeof value.model === "string" && /^[A-Za-z0-9_.-]{1,160}$/.test(value.model) ? value.model : undefined,
    adapterID: ["codex", "openai-api", "github-copilot"].includes(String(value.adapterID)) ? value.adapterID as string : undefined,
    strategy: ["keepalive", "native-prewarm", "bounded-replay"].includes(String(value.strategy)) ? value.strategy as WarmStatus["strategy"] : undefined,
    ttlMs: number(value.ttlMs) && value.ttlMs > 0 ? value.ttlMs : undefined,
    ttlEvidence: ["documented", "upstream-assumed", "requested"].includes(String(value.ttlEvidence)) ? value.ttlEvidence as WarmStatus["ttlEvidence"] : undefined,
    intervalSource: ["automatic", "global", "provider", "model"].includes(String(value.intervalSource)) ? value.intervalSource as WarmStatus["intervalSource"] : undefined,
    sessionID: value.sessionID, phase: value.phase as Phase, startedAt: value.startedAt as number,
    expiresAt: value.expiresAt as number, intervalMs: value.intervalMs as number, durationMs: value.durationMs as number,
    nextAttemptAt: value.nextAttemptAt as number | undefined, attempted: value.attempted as number,
    completed: value.completed as number, failed: value.failed as number, marks, usage: safeUsage(value.usage),
    stoppedAt: value.stoppedAt as number | undefined,
    manualStopped: typeof value.manualStopped === "boolean" ? value.manualStopped : undefined,
    reason: typeof value.reason === "string" && /^[a-z0-9-]{1,80}$/.test(value.reason) ? value.reason : undefined,
  }
}

/** Strip undefined fields so a status survives JSON-Schema validated RPC transfer unchanged. */
export function wireStatus(status: WarmStatus): Record<string, unknown> {
  return JSON.parse(JSON.stringify(status)) as Record<string, unknown>
}

/**
 * In-memory, bounded status table served to the TUI over plugin RPC. Publication is coalesced and
 * fire-and-forget: the warming engine never awaits it, and emit failures never affect warming.
 */
export class StatusRegistry {
  private states = new Map<string, { status: WarmStatus; changedAt: number }>()
  private pending = new Set<string>()
  private timer?: ReturnType<typeof setTimeout>
  private emitting = false
  private closed = false
  private warned = false
  private log: (diagnostic: Diagnostic) => void
  private emit?: (status: WarmStatus) => Promise<void>
  constructor(log: (diagnostic: Diagnostic) => void, emit?: (status: WarmStatus) => Promise<void>) {
    this.log = log
    this.emit = emit
  }

  publish(value: WarmStatus) {
    if (this.closed) return
    const status = safeStatus(value)
    if (!status) return
    if (!this.states.has(status.sessionID) && this.states.size >= MAX_SESSIONS) {
      const oldest = this.states.keys().next().value!
      this.states.delete(oldest)
      this.pending.delete(oldest)
    }
    this.states.delete(status.sessionID)
    this.states.set(status.sessionID, { status, changedAt: Date.now() })
    this.pending.add(status.sessionID)
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; void this.drain() }, EMIT_DELAY_MS)
      this.timer.unref?.()
    }
  }

  get(sessionID: string): WarmStatus | undefined {
    const entry = this.states.get(sessionID)
    if (!entry) return
    const inactive = entry.status.phase === "idle" || entry.status.phase === "stopped" || entry.status.phase === "expired"
    if (!entry.status.manualStopped && inactive && Date.now() - entry.changedAt > RETENTION_MS) {
      this.states.delete(sessionID); return
    }
    return entry.status
  }

  forget(sessionID: string) { this.states.delete(sessionID); this.pending.delete(sessionID) }

  dispose() {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.pending.clear()
    this.states.clear()
  }

  private async drain() {
    if (this.emitting || this.closed || !this.emit) { this.pending.clear(); return }
    this.emitting = true
    try {
      while (!this.closed && this.pending.size) {
        const id = this.pending.values().next().value!
        this.pending.delete(id)
        const status = this.states.get(id)?.status
        if (!status) continue
        try {
          await this.emit(status)
          this.warned = false
        } catch (error) {
          if (!this.warned) {
            this.warned = true
            try { this.log({ event: "ui-status-failed", reason: "publish-failed", ...errorDetails(error) }) } catch { /* Optional UI. */ }
          }
        }
      }
    } finally { this.emitting = false }
  }
}
