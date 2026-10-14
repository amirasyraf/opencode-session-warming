import { randomUUID } from "node:crypto"
import { within } from "./diagnostics.ts"

export const CONTROL_TIMEOUT_MS = 5000
const MAX_BYTES = 1024
const REQUEST_PREFIX = "session-warming.control.v1:"
const ACK_PREFIX = "session-warming.ack.v1:"
export type ControlAction = "start" | "stop"
export type ControlResult = "started" | "stopped" | "already-started" | "already-stopped" | "awaiting-activity" |
  "configured-off" | "unavailable" | "not-root" | "unsupported-session" | "busy" | "expired"
export type ControlRequest = { requestID: string; sessionID: string; action: ControlAction; deadlineAt: number }
type Acknowledgement = ControlRequest & { result: ControlResult }
type Send = (command: string, signal: AbortSignal) => Promise<void>
const results: ControlResult[] = ["started", "stopped", "already-started", "already-stopped", "awaiting-activity",
  "configured-off", "unavailable", "not-root", "unsupported-session", "busy", "expired"]
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)

/** This envelope contains only reconstructed control metadata, never prompt/editor text. */
function decode(command: string, prefix: string, acknowledgement = false): Acknowledgement | ControlRequest | undefined {
  if (!command.startsWith(prefix) || command.length > MAX_BYTES) return
  try {
    const value = JSON.parse(command.slice(prefix.length)) as Record<string, unknown>
    if (!value || typeof value !== "object" || Array.isArray(value) || !id(value.requestID) || !id(value.sessionID) ||
        !["start", "stop"].includes(String(value.action)) || !Number.isSafeInteger(value.deadlineAt) || Number(value.deadlineAt) < 0 ||
        Object.keys(value).some((key) => !["requestID", "sessionID", "action", "deadlineAt", ...(acknowledgement ? ["result"] : [])].includes(key))) return
    const request: ControlRequest = { requestID: value.requestID, sessionID: value.sessionID,
      action: value.action as ControlAction, deadlineAt: value.deadlineAt as number }
    if (!acknowledgement) return request
    if (!results.includes(value.result as ControlResult)) return
    return { ...request, result: value.result as ControlResult }
  } catch { return }
}

export function parseWarmingCommand(text: string): ControlAction | "menu" | "invalid" | undefined {
  const input = text.trim()
  if (!/^\/warming(?:\s|$)/.test(input)) return
  if (input === "/warming") return "menu"
  const match = /^\/warming[ \t]+(start|stop)[ \t]*$/.exec(input)
  return match ? match[1] as ControlAction : "invalid"
}

/** Acknowledgement is required: HTTP acceptance alone does not prove the action was applied. */
export class ControlClient {
  private pending = new Map<string, { request: ControlRequest; finish: (result: ControlResult | "unconfirmed") => void }>()
  private closed = false
  private send: Send
  constructor(send: Send) { this.send = send }

  request(action: ControlAction, sessionID: string): Promise<ControlResult | "unconfirmed"> {
    if (this.closed || !id(sessionID)) return Promise.resolve("unavailable")
    if (this.pending.size >= 8) return Promise.resolve("busy")
    const request: ControlRequest = { requestID: randomUUID(), sessionID, action, deadlineAt: Date.now() + CONTROL_TIMEOUT_MS }
    return new Promise((resolve) => {
      const controller = new AbortController()
      const timer = setTimeout(() => finish("unconfirmed"), CONTROL_TIMEOUT_MS)
      timer.unref()
      const finish = (result: ControlResult | "unconfirmed") => {
        if (!this.pending.delete(request.requestID)) return
        clearTimeout(timer)
        controller.abort()
        resolve(result)
      }
      this.pending.set(request.requestID, { request, finish })
      void Promise.resolve().then(() => {
        if (!controller.signal.aborted) return this.send(REQUEST_PREFIX + JSON.stringify(request), controller.signal)
      })
        .catch(() => finish("unconfirmed"))
    })
  }

  receive(command: string) {
    const ack = decode(command, ACK_PREFIX, true) as Acknowledgement | undefined
    if (!ack) return
    const entry = this.pending.get(ack.requestID)
    if (!entry || entry.request.sessionID !== ack.sessionID || entry.request.action !== ack.action ||
        entry.request.deadlineAt !== ack.deadlineAt || Date.now() >= ack.deadlineAt) return
    entry.finish(ack.result)
  }

  dispose() {
    this.closed = true
    for (const entry of this.pending.values()) entry.finish("unconfirmed")
  }
}

type Entry = { request: ControlRequest; work: Promise<void>; result?: ControlResult; cancelled: boolean }

/** Ordered per-session actions, bounded deduplication, and no mutation after the request deadline. */
export class ControlServer {
  private entries = new Map<string, Entry>()
  private queues = new Map<string, Promise<void>>()
  private acknowledgements = 0
  private closed = false
  private apply: (request: ControlRequest, current: () => boolean) => Promise<ControlResult>
  private send: Send
  constructor(apply: (request: ControlRequest, current: () => boolean) => Promise<ControlResult>, send: Send) {
    this.apply = apply; this.send = send
  }

  async receive(command: string) {
    const request = decode(command, REQUEST_PREFIX) as ControlRequest | undefined
    if (this.closed || !request) return
    const now = Date.now()
    if (request.deadlineAt <= now || request.deadlineAt > now + CONTROL_TIMEOUT_MS) return
    for (const [key, entry] of this.entries) if (entry.request.deadlineAt + CONTROL_TIMEOUT_MS <= now) this.entries.delete(key)
    const existing = this.entries.get(request.requestID)
    if (existing) {
      if (existing.request.sessionID !== request.sessionID || existing.request.action !== request.action ||
          existing.request.deadlineAt !== request.deadlineAt) return
      if (existing.result) await this.acknowledge(request, existing.result)
      return
    }
    if (this.entries.size >= 128 || this.queues.size >= 32) { await this.acknowledge(request, "busy"); return }
    const previous = this.queues.get(request.sessionID) ?? Promise.resolve()
    const entry: Entry = { request, work: Promise.resolve(), cancelled: false }
    this.entries.set(request.requestID, entry)
    const current = () => !this.closed && !entry.cancelled && this.entries.get(request.requestID) === entry && Date.now() < request.deadlineAt
    entry.work = previous.then(async () => {
      try {
        entry.result = current() ? await within(() => this.apply(request, current),
          Math.max(1, request.deadlineAt - Date.now()), "metadata-timeout") : "expired"
      } catch { entry.result = "unavailable" }
      if (!this.closed) await this.acknowledge(request, entry.result)
    }).finally(() => {
      if (this.queues.get(request.sessionID) === entry.work) this.queues.delete(request.sessionID)
    })
    this.queues.set(request.sessionID, entry.work)
    await entry.work
  }

  cancel(sessionID: string) {
    for (const entry of this.entries.values()) if (entry.request.sessionID === sessionID) entry.cancelled = true
  }

  dispose() { this.closed = true; this.entries.clear(); this.queues.clear() }

  private async acknowledge(request: ControlRequest, result: ControlResult) {
    if (this.closed || this.acknowledgements >= 32) return
    this.acknowledgements++
    try { await within((signal) => this.send(ACK_PREFIX + JSON.stringify({ ...request, result }), signal), 1000, "metadata-timeout") }
    catch { /* The client reports an unconfirmed result; failed delivery never affects warming. */ }
    finally { this.acknowledgements-- }
  }
}
