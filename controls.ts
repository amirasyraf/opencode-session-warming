import { within } from "./diagnostics.ts"

export const CONTROL_TIMEOUT_MS = 5000
export type ControlAction = "start" | "stop"
export type ControlResult = "started" | "stopped" | "already-started" | "already-stopped" | "awaiting-activity" |
  "configured-off" | "native-warming" | "unavailable" | "not-root" | "busy" | "expired"
export type ControlRequest = { requestID: string; sessionID: string; action: ControlAction; deadlineAt: number }
export const controlResults: readonly ControlResult[] = ["started", "stopped", "already-started", "already-stopped", "awaiting-activity",
  "configured-off", "native-warming", "unavailable", "not-root", "busy", "expired"]
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)

/** Validate an RPC control input. Only reconstructed metadata is accepted; editor text never crosses. */
export function controlRequest(value: unknown, now = Date.now()): ControlRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !["requestID", "sessionID", "action"].includes(key))) return
  if (!id(input.requestID) || !id(input.sessionID) || (input.action !== "start" && input.action !== "stop")) return
  return { requestID: input.requestID, sessionID: input.sessionID, action: input.action, deadlineAt: now + CONTROL_TIMEOUT_MS }
}

/** Arguments after `/warming`, as passed by OpenCode V2's argument slash commands. */
export function parseWarmingArguments(input: string | undefined): ControlAction | "menu" | "invalid" {
  const value = (input ?? "").trim()
  if (!value) return "menu"
  return value === "start" || value === "stop" ? value : "invalid"
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
      if (existing.request.sessionID !== request.sessionID || existing.request.action !== request.action) return "busy"
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
