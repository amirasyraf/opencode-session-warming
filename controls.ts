import { within } from "./diagnostics.ts"
import { MAX_TIMER } from "./cache-policy.ts"

export const CONTROL_TIMEOUT_MS = 5000
export type ControlAction = "start" | "stop" | "extend"
export type ControlResult = "started" | "stopped" | "already-started" | "already-stopped" | "awaiting-activity" |
  "extended" | "duration-limit" | "configured-off" | "native-warming" | "unavailable" | "not-root" | "busy" | "expired"
/** `durationMs` is present only for an explicit `extend` duration; a bare extend adds one configured window. */
export type ControlRequest = { requestID: string; sessionID: string; action: ControlAction; deadlineAt: number; durationMs?: number }
export type WarmingCommand = "start" | "stop" | "menu" | "invalid" | { action: "extend"; durationMs?: number }
export const controlResults: readonly ControlResult[] = ["started", "stopped", "already-started", "already-stopped", "awaiting-activity",
  "extended", "duration-limit", "configured-off", "native-warming", "unavailable", "not-root", "busy", "expired"]
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)

/** Validate an RPC control input. Only reconstructed metadata is accepted; editor text never crosses. */
export function controlRequest(value: unknown, now = Date.now()): ControlRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !["requestID", "sessionID", "action", "durationMs"].includes(key))) return
  if (!id(input.requestID) || !id(input.sessionID) || !["start", "stop", "extend"].includes(input.action as string)) return
  if (input.durationMs !== undefined && (input.action !== "extend" || !validDuration(input.durationMs))) return
  return { requestID: input.requestID, sessionID: input.sessionID, action: input.action as ControlAction, deadlineAt: now + CONTROL_TIMEOUT_MS,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs as number }) }
}

const validDuration = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMER

/** Parse a bounded ASCII duration (`30m`, `1h`, `1h30m`) without locale, decimal, or whitespace variants. */
export function parseDuration(value: string): number | undefined {
  if (!value) return
  const units: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  let total = 0
  let end = 0
  let previous = Infinity
  for (const match of value.matchAll(/(\d+)([smhd])/g)) {
    if (match.index !== end) return
    const unit = units[match[2]!]!
    const amount = Number(match[1])
    const milliseconds = amount * unit
    // Units must strictly descend, which also rejects repeated units.
    if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(milliseconds) || unit >= previous || total > MAX_TIMER - milliseconds) return
    total += milliseconds
    previous = unit
    end += match[0].length
  }
  return end === value.length && total > 0 ? total : undefined
}

/** Arguments after `/warming`, as passed by OpenCode V2's argument slash commands. */
export function parseWarmingArguments(input: string | undefined): WarmingCommand {
  const value = (input ?? "").trim()
  if (!value) return "menu"
  if (value === "start" || value === "stop") return value
  const match = /^extend(?:[ \t]+([^ \t]+))?$/.exec(value)
  if (!match) return "invalid"
  if (match[1] === undefined) return { action: "extend" }
  const durationMs = parseDuration(match[1])
  return durationMs === undefined ? "invalid" : { action: "extend", durationMs }
}

type Entry = { request: ControlRequest; work: Promise<ControlResult>; cancelled: boolean }

/**
 * Ordered per-session actions, bounded deduplication, and no mutation after the request deadline.
 * The RPC response is the correlated acknowledgement; a duplicate request ID never applies twice.
 */
export class ControlServer {
  private entries = new Map<string, Entry>()
  private queues = new Map<string, Promise<unknown>>()
  private closed = false
  private apply: (request: ControlRequest, current: () => boolean) => Promise<ControlResult>
  constructor(apply: (request: ControlRequest, current: () => boolean) => Promise<ControlResult>) { this.apply = apply }

  async receive(request: ControlRequest): Promise<ControlResult> {
    if (this.closed) return "unavailable"
    const now = Date.now()
    for (const [key, entry] of this.entries) if (entry.request.deadlineAt + CONTROL_TIMEOUT_MS <= now) this.entries.delete(key)
    const existing = this.entries.get(request.requestID)
    if (existing) {
      if (existing.request.sessionID !== request.sessionID || existing.request.action !== request.action ||
          existing.request.durationMs !== request.durationMs) return "busy"
      return existing.work
    }
    if (this.entries.size >= 128 || this.queues.size >= 32) return "busy"
    const previous = this.queues.get(request.sessionID) ?? Promise.resolve()
    const entry: Entry = { request, work: Promise.resolve("expired"), cancelled: false }
    this.entries.set(request.requestID, entry)
    const current = () => !this.closed && !entry.cancelled && this.entries.get(request.requestID) === entry && Date.now() < request.deadlineAt
    entry.work = previous.then(async (): Promise<ControlResult> => {
      try {
        return current() ? await within(() => this.apply(request, current), Math.max(1, request.deadlineAt - Date.now()), "metadata-timeout") : "expired"
      } catch { return current() ? "unavailable" : "expired" }
    })
    const settled = entry.work.finally(() => {
      if (this.queues.get(request.sessionID) === settled) this.queues.delete(request.sessionID)
    })
    this.queues.set(request.sessionID, settled)
    return entry.work
  }

  cancel(sessionID: string) {
    for (const entry of this.entries.values()) if (entry.request.sessionID === sessionID) entry.cancelled = true
  }

  dispose() { this.closed = true; this.entries.clear(); this.queues.clear() }
}
