import { randomUUID } from "node:crypto"
import { classifyRequest, discardWarmResponse, retryAfterMs, warmRequest } from "./protocol.ts"
import { abortableFetch, errorDetails } from "./diagnostics.ts"
import type { Diagnostic } from "./diagnostics.ts"
import type { Snapshot } from "./protocol.ts"
import type { Observation, Transport } from "./transport.ts"
import type { Mark, Phase, WarmStatus } from "./status.ts"

export type Settings = { enabled: boolean; intervalMs: number; durationMs: number; debug?: boolean }
export type { Diagnostic } from "./diagnostics.ts"
export type Clock = {
  now: () => number
  set: (callback: () => void, delay: number) => unknown
  clear: (timer: unknown) => void
}
const MAX_TIMER = 2_147_483_647
const REQUEST_TIMEOUT_MS = 30_000
export const systemClock: Clock = {
  now: Date.now,
  set(callback, delay) { const timer = setTimeout(callback, delay); timer.unref(); return timer },
  clear(timer) { clearTimeout(timer as ReturnType<typeof setTimeout>) },
}

export function settingsError(options: Record<string, unknown> = {}): string | undefined {
  if (Object.keys(options).some((key) => !["enabled", "intervalMs", "durationMs", "debug"].includes(key))) return "unknown-option"
  const enabled = options.enabled ?? true
  const debug = options.debug ?? false
  const intervalMs = options.intervalMs ?? 240_000
  const durationMs = options.durationMs ?? 3_600_000
  if (typeof enabled !== "boolean") return "invalid-enabled"
  if (typeof debug !== "boolean") return "invalid-debug"
  if (typeof intervalMs !== "number" || !Number.isSafeInteger(intervalMs) || intervalMs <= 0 || intervalMs > MAX_TIMER) return "invalid-interval"
  if (typeof durationMs !== "number" || !Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > MAX_TIMER) return "invalid-duration"
  if (intervalMs >= durationMs) return "interval-not-less-than-duration"
}

export function settings(options: Record<string, unknown> = {}): Settings | undefined {
  if (settingsError(options)) return
  return { enabled: options.enabled as boolean ?? true, intervalMs: options.intervalMs as number ?? 240_000,
    durationMs: options.durationMs as number ?? 3_600_000, debug: options.debug as boolean ?? false }
}

type State = {
  token: string
  attempt: number
  active: boolean
  expiresAt?: number
  nextAt?: number
  snapshot?: Snapshot
  timer?: unknown
  warm?: AbortController
  pending?: Observation
  warms: number
  startedAt: number
  completed: number
  failed: number
  marks: Mark[]
}

/** No task counters: only ordinary root-model transport activity matters. */
export class WarmingEngine {
  private states = new Map<string, State>()
  private disposed = false
  private config: Settings
  private http: Transport
  private log: (diagnostic: Diagnostic) => void
  private clock: Clock
  private observer?: (status: WarmStatus) => void
  constructor(
    config: Settings,
    http: Transport,
    log: (diagnostic: Diagnostic) => void,
    clock: Clock = systemClock,
    observer?: (status: WarmStatus) => void,
  ) {
    this.config = config
    this.http = http
    this.log = log
    this.clock = clock
    this.observer = observer
  }

  has(sessionID: string) { return this.states.has(sessionID) }

  prepare(sessionID: string, capture: boolean): string | undefined {
    this.invalidate(sessionID, "ordinary-activity")
    if (this.disposed || !this.config.enabled || !capture) return
    const state: State = { token: randomUUID(), attempt: 0, warms: 0, active: false,
      startedAt: this.clock.now(), completed: 0, failed: 0, marks: [] }
    this.states.set(sessionID, state)
    // Also expire preparation that never reaches the HTTP transport.
    state.expiresAt = this.clock.now() + this.config.durationMs
    this.http.register(state.token, (url, init) => this.start(sessionID, state, url, init))
    this.schedule(sessionID, state)
    this.notify(sessionID, state, "preparing")
    return state.token
  }

  invalidate(sessionID: string, reason: string) {
    const state = this.states.get(sessionID)
    if (!state) return
    this.states.delete(sessionID)
    if (state.timer !== undefined) this.clock.clear(state.timer)
    if (state.warm) {
      const last = state.marks.at(-1)
      if (last?.result === "sending") last.result = "aborted"
      state.warm.abort(reason)
    }
    if (state.pending) state.pending.complete = undefined
    state.pending = undefined
    state.snapshot = undefined
    this.http.remove(state.token)
    this.emit({ event: "stopped", sessionID, reason })
    this.notify(sessionID, state, reason === "expired" ? "expired" : "stopped", reason)
  }

  dispose() {
    this.disposed = true
    for (const id of this.states.keys()) this.invalidate(id, "disposed")
  }

  private emit(diagnostic: Diagnostic) {
    try { this.log(diagnostic) } catch { /* Diagnostics never control session behavior. */ }
  }

  inactive(sessionID: string, reason: string) {
    if (this.disposed) return
    this.notify(sessionID, { token: "", attempt: 0, warms: 0, active: false, startedAt: this.clock.now(),
      expiresAt: 0, completed: 0, failed: 0, marks: [] }, "stopped", reason)
  }

  private notify(sessionID: string, state: State, phase: Phase, reason?: string) {
    if (phase !== "stopped" && phase !== "expired" && !this.current(sessionID, state)) return
    try {
      this.observer?.({ sessionID, phase, startedAt: state.startedAt, expiresAt: state.expiresAt ?? 0,
        intervalMs: this.config.intervalMs, durationMs: this.config.durationMs,
        nextAttemptAt: phase === "waiting" && state.nextAt! < state.expiresAt! ? state.nextAt : undefined,
        attempted: state.warms, completed: state.completed, failed: state.failed, reason,
        stoppedAt: phase === "stopped" || phase === "expired" ? this.clock.now() : undefined,
        marks: state.marks.map((mark) => ({ ...mark })) })
    } catch (error) { this.emit({ event: "ui-status-failed", reason: "observer-failed", ...errorDetails(error) }) }
  }

  private current(sessionID: string, state: State) {
    return !this.disposed && this.states.get(sessionID) === state
  }

  private start(sessionID: string, state: State, url: string, init: RequestInit) {
    if (!this.current(sessionID, state)) return
    if (state.expiresAt !== undefined && this.clock.now() >= state.expiresAt) {
      this.invalidate(sessionID, "expired"); return
    }
    state.warm?.abort("ordinary-activity")
    state.warm = undefined
    if (state.pending) state.pending.complete = undefined
    state.pending = undefined
    state.snapshot = undefined
    state.active = true
    const attempt = ++state.attempt
    const now = this.clock.now()
    state.startedAt = now
    state.warms = 0
    state.completed = 0
    state.failed = 0
    state.marks = []
    state.expiresAt = now + this.config.durationMs
    state.nextAt = now + this.config.intervalMs
    const capture = classifyRequest(url, init)
    if (!capture.snapshot) {
      this.emit({ event: "skipped", sessionID, providerID: "openai", reason: capture.reason })
      this.invalidate(sessionID, capture.reason)
      return
    }
    const snapshot = capture.snapshot
    this.schedule(sessionID, state)
    this.notify(sessionID, state, "generating")
    const observation: Observation = { complete: (ok, failure) => {
      if (!this.current(sessionID, state) || attempt !== state.attempt) return
      state.pending = undefined
      state.active = false
      if (this.clock.now() >= state.expiresAt!) { this.invalidate(sessionID, "expired"); return }
      if (ok) {
        state.snapshot = snapshot
        this.emit({ event: "captured", sessionID, providerID: "openai", model: String(snapshot.body.model),
          nextAttemptAt: Math.max(this.clock.now(), state.nextAt!) < state.expiresAt! ? Math.max(this.clock.now(), state.nextAt!) : undefined,
          expiresAt: state.expiresAt })
      } else {
        this.emit({ event: "capture-failed", sessionID, providerID: "openai", reason: "ordinary-transport-failed", ...failure })
      }
      // Leave registration alive for ordinary transport retries using the same marker.
      this.schedule(sessionID, state)
      this.notify(sessionID, state, ok ? "waiting" : "stopped", ok ? undefined : "ordinary-transport-failed")
    } }
    state.pending = observation
    return observation
  }

  private schedule(sessionID: string, state: State) {
    if (!this.current(sessionID, state)) return
    if (state.timer !== undefined) this.clock.clear(state.timer)
    const now = this.clock.now()
    const expires = state.expiresAt!
    if (now >= expires) { this.invalidate(sessionID, "expired"); return }
    const deadline = !state.active && state.snapshot && !state.warm ? Math.min(state.nextAt!, expires) : expires
    state.timer = this.clock.set(() => {
      state.timer = undefined
      if (!this.current(sessionID, state)) return
      if (this.clock.now() >= expires) { this.invalidate(sessionID, "expired"); return }
      void this.warm(sessionID, state).catch((error: unknown) => {
        this.emit({ event: "internal-error", sessionID, ...errorDetails(error) })
        if (this.current(sessionID, state)) this.invalidate(sessionID, "internal-error")
      })
    }, Math.max(0, deadline - now))
  }

  private async warm(sessionID: string, state: State) {
    if (!this.current(sessionID, state) || state.active || state.warm || !state.snapshot) return
    const controller = new AbortController()
    state.warm = controller
    this.schedule(sessionID, state) // Keep the absolute deadline active during a warm request.
    const timeout = this.clock.set(() => controller.abort("request-timeout"), Math.min(REQUEST_TIMEOUT_MS, state.expiresAt! - this.clock.now()))
    const startedAt = this.clock.now()
    let delay = this.config.intervalMs
    const context = { sessionID, providerID: "openai", model: String(state.snapshot.body.model),
      attemptID: randomUUID(), attempt: ++state.warms, expiresAt: state.expiresAt }
    const mark: Mark = { at: startedAt, result: "sending" }
    state.marks.push(mark)
    if (state.marks.length > 128) state.marks.shift()
    this.notify(sessionID, state, "sending")
    let status: number | undefined
    let requestID: string | undefined
    const currentWarm = () => this.current(sessionID, state) && state.warm === controller
    this.emit({ event: "warm-started", ...context })
    try {
      const response = await abortableFetch(this.http.fetch, state.snapshot.url, warmRequest(state.snapshot, controller.signal), controller.signal)
      status = response.status
      requestID = response.headers.get("x-request-id") ?? undefined
      if ([400, 401, 403, 422].includes(response.status)) {
        mark.result = "failed"
        if (currentWarm()) state.failed++
        void response.body?.cancel().catch(() => {})
        this.emit({ event: "warm-failed", ...context, status, requestID, retryable: false,
          reason: [401, 403].includes(status) ? "http-auth" : "http-incompatible", elapsedMs: this.clock.now() - startedAt })
        if (this.current(sessionID, state) && state.warm === controller) this.invalidate(sessionID, `http-${response.status}`)
        return
      }
      if (!response.ok) {
        mark.result = "failed"
        if (currentWarm()) state.failed++
        if (response.status === 429) delay = Math.max(delay, retryAfterMs(response.headers.get("retry-after"), this.clock.now()))
        void response.body?.cancel().catch(() => {})
        this.emit({ event: "warm-failed", ...context, status, requestID, retryable: this.clock.now() + delay < state.expiresAt!,
          reason: status === 429 ? "http-rate-limit" : status >= 500 ? "http-server" : "http-error",
          elapsedMs: this.clock.now() - startedAt,
          nextAttemptAt: this.clock.now() + delay < state.expiresAt! ? this.clock.now() + delay : undefined })
      } else {
        const usage = await discardWarmResponse(response, controller.signal)
        mark.result = "completed"
        if (currentWarm()) state.completed++
        this.emit({ event: "warm-completed", ...context, status, requestID, elapsedMs: this.clock.now() - startedAt,
          nextAttemptAt: this.clock.now() + delay < state.expiresAt! ? this.clock.now() + delay : undefined,
          inputTokens: usage?.inputTokens, cachedTokens: usage?.cachedTokens, outputTokens: usage?.outputTokens })
      }
    } catch (error) {
      mark.result = controller.signal.aborted ? "aborted" : "failed"
      if (!controller.signal.aborted && currentWarm()) state.failed++
      this.emit({ event: controller.signal.aborted ? "warm-aborted" : "warm-failed", ...context, status, requestID,
        reason: controller.signal.aborted ? String(controller.signal.reason) : "request-failed",
        elapsedMs: this.clock.now() - startedAt,
        retryable: this.current(sessionID, state) && state.warm === controller && this.clock.now() + delay < state.expiresAt!,
        nextAttemptAt: this.current(sessionID, state) && state.warm === controller && this.clock.now() + delay < state.expiresAt! ? this.clock.now() + delay : undefined,
        ...(controller.signal.aborted ? { errorCategory: controller.signal.reason === "request-timeout" ? "timeout" : "aborted" } : errorDetails(error)) })
    } finally {
      this.clock.clear(timeout)
      if (this.current(sessionID, state) && state.warm === controller) {
        state.warm = undefined
        state.nextAt = this.clock.now() + delay
        this.emit({ event: "scheduled", ...context, nextAttemptAt: state.nextAt < state.expiresAt! ? state.nextAt : undefined,
          retryable: state.nextAt < state.expiresAt! })
        this.schedule(sessionID, state)
        this.notify(sessionID, state, "waiting")
      }
    }
  }
}
