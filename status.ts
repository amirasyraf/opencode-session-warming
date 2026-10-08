import { randomUUID } from "node:crypto"
import { mkdir, open, readdir, rename, stat, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { errorDetails } from "./diagnostics.ts"
import type { Diagnostic } from "./diagnostics.ts"

export type Phase = "preparing" | "generating" | "waiting" | "sending" | "stopped" | "expired"
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
  marks: Mark[]
}
type Record = { schema: 1; owner: string; pid: number; heartbeatAt: number; status: WarmStatus }
export type StatusRead = { status?: WarmStatus; unavailable?: "stale" | "invalid" | "read-failed" }
const RETENTION_MS = 3_600_000
const MAX_BYTES = 64 * 1024
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

export function statusDirectory(): string {
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode", "session-warming", "status")
}

/** Reconstruct only allowed metadata fields; snapshots, headers, prompts, and errors never enter IPC. */
function safeStatus(value: unknown): WarmStatus | undefined {
  if (!object(value) || typeof value.sessionID !== "string" || !safeID(value.sessionID) ||
      !["preparing", "generating", "waiting", "sending", "stopped", "expired"].includes(String(value.phase)) ||
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
    reason: typeof value.reason === "string" && /^[a-z0-9-]{1,80}$/.test(value.reason) ? value.reason : undefined,
  }
}

export async function readStatus(sessionID: string, directory = statusDirectory(), now = Date.now()): Promise<StatusRead> {
  if (!safeID(sessionID)) return { unavailable: "invalid" }
  let file
  try {
    file = await open(join(directory, `${sessionID}.json`), "r")
    if ((await file.stat()).size > MAX_BYTES) return { unavailable: "invalid" }
    const value: unknown = JSON.parse(await file.readFile("utf8"))
    if (!object(value) || value.schema !== 1 || !number(value.pid) || !value.pid || !number(value.heartbeatAt)) return { unavailable: "invalid" }
    const status = safeStatus(value.status)
    if (!status || status.sessionID !== sessionID) return { unavailable: "invalid" }
    if (now - value.heartbeatAt > 15_000 || value.heartbeatAt > now + 5000) return { unavailable: "stale" }
    try { process.kill(value.pid, 0) } catch { return { unavailable: "stale" } }
    return { status }
  } catch (error) {
    if (object(error) && error.code === "ENOENT") return {}
    return { unavailable: error instanceof SyntaxError ? "invalid" : "read-failed" }
  } finally { await file?.close().catch(() => {}) }
}

/** Independent, coalesced metadata writes. The warming engine never awaits filesystem work. */
export class StatusPublisher {
  private owner = randomUUID()
  private states = new Map<string, { status: WarmStatus; changedAt: number }>()
  private pending = new Map<string, WarmStatus>()
  private work?: Promise<void>
  private timer?: ReturnType<typeof setInterval>
  private closed = false
  private initialized = false
  private warned = false
  private directory: string
  private log: (diagnostic: Diagnostic) => void
  constructor(log: (diagnostic: Diagnostic) => void, directory = statusDirectory()) {
    this.log = log
    this.directory = directory
  }

  publish(value: WarmStatus) {
    if (this.closed) return
    const status = safeStatus(value)
    if (!status) return
    if (!this.states.has(status.sessionID) && this.states.size >= 64) {
      const oldest = this.states.keys().next().value!
      this.states.delete(oldest)
      this.pending.delete(oldest)
      void this.removeOwned(oldest)
    }
    this.states.set(status.sessionID, { status, changedAt: Date.now() })
    this.pending.set(status.sessionID, status)
    if (!this.timer) {
      this.timer = setInterval(() => {
        for (const [id, entry] of this.states) {
          if ((entry.status.phase === "stopped" || entry.status.phase === "expired") && Date.now() - entry.changedAt > RETENTION_MS) {
            this.states.delete(id)
            this.pending.delete(id)
            void this.removeOwned(id)
          } else this.pending.set(id, entry.status)
        }
        this.drain()
        if (!this.states.size && this.timer) { clearInterval(this.timer); this.timer = undefined }
      }, 5000)
      this.timer.unref()
    }
    this.drain()
  }

  async flush() {
    while (this.work) await this.work
  }

  async dispose() {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.pending.clear()
    await this.flush()
    await Promise.all([...this.states.keys()].map((id) => this.removeOwned(id)))
    this.states.clear()
  }

  private async removeOwned(id: string) {
    let handle
    try {
      const file = join(this.directory, `${id}.json`)
      handle = await open(file, "r")
      if ((await handle.stat()).size > MAX_BYTES) return
      const value: unknown = JSON.parse(await handle.readFile("utf8"))
      if (object(value) && value.owner === this.owner) await unlink(file)
    } catch { /* Best-effort cleanup; readers also reject stale status. */ }
    finally { await handle?.close().catch(() => {}) }
  }

  private drain() {
    if (this.work || !this.pending.size || this.closed) return
    this.work = (async () => {
      if (!this.initialized) {
        await mkdir(this.directory, { recursive: true, mode: 0o700 })
        // Bound startup cleanup; active writers refresh mtime every five seconds.
        for (const name of (await readdir(this.directory)).filter((name) => name.endsWith(".json") || name.endsWith(".tmp")).slice(0, 256)) {
          const path = join(this.directory, name)
          const age = await stat(path).then((file) => Date.now() - file.mtimeMs, () => 0)
          if (age > RETENTION_MS) await unlink(path).catch(() => {})
        }
        this.initialized = true
      }
      while (!this.closed && this.pending.size) {
        const [id, status] = this.pending.entries().next().value!
        this.pending.delete(id)
        const temporary = join(this.directory, `${id}.${this.owner}.tmp`)
        const record: Record = { schema: 1, owner: this.owner, pid: process.pid, heartbeatAt: Date.now(), status }
        try {
          await writeFile(temporary, JSON.stringify(record), { mode: 0o600 })
          if (!this.closed) await rename(temporary, join(this.directory, `${id}.json`))
        } finally { await unlink(temporary).catch(() => {}) }
      }
      this.warned = false
    })().catch((error: unknown) => {
      this.pending.clear()
      if (!this.warned) {
        this.warned = true
        try { this.log({ event: "ui-status-failed", reason: "write-failed", ...errorDetails(error) }) } catch { /* Optional UI. */ }
      }
    }).finally(() => { this.work = undefined; this.drain() })
  }
}
