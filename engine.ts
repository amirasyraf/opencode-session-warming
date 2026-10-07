import { randomUUID } from "node:crypto"
import { retryAfterMs } from "./protocol.ts"
import { abortableFetch, errorDetails } from "./diagnostics.ts"
import type { Diagnostic } from "./diagnostics.ts"
import { capture } from "./adapters.ts"
import type { ModelContext, Replay } from "./adapters.ts"
import { initialProfile, LEGACY_INTERVAL_MS, resolvePolicy } from "./cache-policy.ts"
import type { CacheProfile, Settings } from "./cache-policy.ts"
import type { Observation, Transport } from "./transport.ts"
import type { Mark, Phase, WarmStatus } from "./status.ts"

export { settings, settingsError } from "./cache-policy.ts"
export type { Settings } from "./cache-policy.ts"
export type { Diagnostic } from "./diagnostics.ts"
export type Clock = {
  now: () => number
  set: (callback: () => void, delay: number) => unknown
  clear: (timer: unknown) => void
}
const REQUEST_TIMEOUT_MS = 30_000
const CLOCK_GAP_CHECK_MS = 5_000
const CLOCK_GAP_TOLERANCE_MS = 5_000
export const systemClock: Clock = {
  now: Date.now,
  set(callback, delay) { const timer = setTimeout(callback, delay); timer.unref(); return timer },
  clear(timer) { clearTimeout(timer as ReturnType<typeof setTimeout>) },
}

type State = {
  context: ModelContext
  policy: CacheProfile
  token: string
  attempt: number
  active: boolean
  expiresAt?: number
  nextAt?: number
  snapshot?: Replay
  timer?: unknown
  wakeAt?: number
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

  prepare(sessionID: string, eligible: boolean, context: ModelContext = { providerID: "openai", modelID: "gpt-test" }): string | undefined {
    this.invalidate(sessionID, "ordinary-activity")
    if (this.disposed || !this.config.enabled || !eligible) return
    const policy = resolvePolicy(this.config, context.providerID, context.modelID, initialProfile(context.modelID))
    if (!policy.enabled) { this.inactive(sessionID, "configured-off", context); return }
    const state: State = { context, policy, token: randomUUID(), attempt: 0, warms: 0, active: false,
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

  inactive(sessionID: string, reason: string, context: ModelContext = { providerID: "", modelID: "" }) {
    if (this.disposed) return
    this.notify(sessionID, { context, policy: { enabled: false,
      intervalMs: this.config.intervalMs ?? LEGACY_INTERVAL_MS, intervalSource: "automatic", ttlEvidence: "upstream-assumed" },
      token: "", attempt: 0, warms: 0, active: false, startedAt: this.clock.now(),
      expiresAt: 0, completed: 0, failed: 0, marks: [] }, "stopped", reason)
  }

  private notify(sessionID: string, state: State, phase: Phase, reason?: string) {
    if (phase !== "stopped" && phase !== "expired" && !this.current(sessionID, state)) return
    try {
      this.observer?.({ sessionID, phase, startedAt: state.startedAt, expiresAt: state.expiresAt ?? 0,
        intervalMs: state.policy.intervalMs, durationMs: this.config.durationMs,
        providerID: state.context.providerID || undefined, model: state.context.modelID || undefined,
        adapterID: state.snapshot?.adapterID, strategy: state.snapshot?.strategy,
        ttlMs: state.policy.ttlMs, ttlEvidence: state.policy.ttlEvidence, intervalSource: state.policy.intervalSource,
        nextAttemptAt: phase === "waiting" && state.nextAt! < state.expiresAt! ? state.nextAt : undefined,
        attempted: state.warms, completed: state.completed, failed: state.failed, reason,
        stoppedAt: phase === "stopped" || phase === "expired" ? this.clock.now() : undefined,
        marks: state.marks.map((mark) => ({ ...mark })) })
    } catch (error) { this.emit({ event: "ui-status-failed", reason: "observer-failed", ...errorDetails(error) }) }
  }

  private current(sessionID: string, state: State) {
    return !this.disposed && this.states.get(sessionID) === state
  }

  /** A queued network continuation can beat an overdue timer after resume. */
  private clockCurrent(sessionID: string, state: State) {
    if (!this.current(sessionID, state)) return false
    const now = this.clock.now()
    if (now >= state.expiresAt!) { this.invalidate(sessionID, "expired"); return false }
    if (state.wakeAt !== undefined && now - state.wakeAt > CLOCK_GAP_TOLERANCE_MS) {
      this.invalidate(sessionID, "clock-gap"); return false
    }
    return true
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
    const result = capture(state.context, url, init)
    if (!result.replay) {
      this.emit({ event: "skipped", sessionID, providerID: state.context.providerID, model: state.context.modelID, reason: result.reason })
      this.invalidate(sessionID, result.reason)
      return
    }
    const snapshot = result.replay
    state.policy = resolvePolicy(this.config, state.context.providerID, state.context.modelID, snapshot.automatic)
    state.nextAt = now + state.policy.intervalMs
    if (state.policy.ttlMs !== undefined && state.policy.intervalMs >= state.policy.ttlMs) this.emit({ event: "policy-warning",
      sessionID, providerID: state.context.providerID, model: state.context.modelID, reason: "interval-exceeds-ttl", intervalMs: state.policy.intervalMs, ttlMs: state.policy.ttlMs })
    this.schedule(sessionID, state)
    this.notify(sessionID, state, "generating")
    const observation: Observation = { complete: (ok, failure) => {
      if (!this.current(sessionID, state) || attempt !== state.attempt) return
      state.pending = undefined
      state.active = false
      if (this.clock.now() >= state.expiresAt!) { this.invalidate(sessionID, "expired"); return }
      if (ok) {
        state.snapshot = snapshot
        this.emit({ event: "captured", sessionID, providerID: state.context.providerID, model: state.context.modelID,
          adapterID: snapshot.adapterID, strategy: snapshot.strategy, ...state.policy,
          nextAttemptAt: Math.max(this.clock.now(), state.nextAt!) < state.expiresAt! ? Math.max(this.clock.now(), state.nextAt!) : undefined,
          expiresAt: state.expiresAt })
      } else {
        this.emit({ event: "capture-failed", sessionID, providerID: state.context.providerID, model: state.context.modelID, reason: "ordinary-transport-failed", ...failure })
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
    if (state.warm && !this.clockCurrent(sessionID, state)) return
    if (state.timer !== undefined) this.clock.clear(state.timer)
    const now = this.clock.now()
    const expires = state.expiresAt!
    if (now >= expires) { this.invalidate(sessionID, "expired"); return }
    const deadline = Math.max(now, state.warm ? Math.min(expires, now + CLOCK_GAP_CHECK_MS) :
      !state.active && state.snapshot ? Math.min(state.nextAt!, expires) : expires)
    state.wakeAt = deadline
    state.timer = this.clock.set(() => {
      state.timer = undefined
      if (!this.current(sessionID, state)) return
      const current = this.clock.now()
      if (current >= expires) { this.invalidate(sessionID, "expired"); return }
      if (current - deadline > CLOCK_GAP_TOLERANCE_MS) { this.invalidate(sessionID, "clock-gap"); return }
      if (state.warm) { this.schedule(sessionID, state); return }
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
    this.schedule(sessionID, state) // Keep expiry and the clock-gap watchdog active during a warm request.
    const startedAt = this.clock.now()
    const timeoutAt = Math.min(startedAt + REQUEST_TIMEOUT_MS, state.expiresAt!)
    const timeout = this.clock.set(() => {
      if (!this.current(sessionID, state) || state.warm !== controller) return
      const current = this.clock.now()
      if (current >= state.expiresAt!) { this.invalidate(sessionID, "expired"); return }
      if (current - timeoutAt > CLOCK_GAP_TOLERANCE_MS) { this.invalidate(sessionID, "clock-gap"); return }
      controller.abort("request-timeout")
    }, Math.max(0, timeoutAt - startedAt))
    // Retry throttling is independent of long successful-refresh intervals.
    let delay = Math.min(state.policy.intervalMs, 30_000)
    let succeeded = false
    const context = { sessionID, providerID: state.context.providerID, model: state.context.modelID,
      adapterID: state.snapshot.adapterID, strategy: state.snapshot.strategy,
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
      const response = await abortableFetch(this.http.fetch, state.snapshot.snapshot.url, state.snapshot.request(controller.signal), controller.signal)
      if (!this.clockCurrent(sessionID, state)) { void response.body?.cancel().catch(() => {}); return }
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
        const usage = await state.snapshot.drain(response, controller.signal)
        if (!this.clockCurrent(sessionID, state)) return
        succeeded = true
        delay = Math.max(Math.min(state.policy.intervalMs, 1000), startedAt + state.policy.intervalMs - this.clock.now())
        mark.result = "completed"
        if (currentWarm()) state.completed++
        this.emit({ event: "warm-completed", ...context, status, requestID, elapsedMs: this.clock.now() - startedAt,
          nextAttemptAt: this.clock.now() + delay < state.expiresAt! ? this.clock.now() + delay : undefined,
          inputTokens: usage?.inputTokens, cachedTokens: usage?.cachedTokens, outputTokens: usage?.outputTokens,
          cacheWriteTokens: usage?.cacheWriteTokens, cacheWrite5mTokens: usage?.cacheWrite5mTokens,
          cacheWrite1hTokens: usage?.cacheWrite1hTokens, outputLimitReached: usage?.outputLimitReached })
      }
    } catch (error) {
      this.clockCurrent(sessionID, state)
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
      if (this.clockCurrent(sessionID, state) && state.warm === controller) {
        state.warm = undefined
        state.nextAt = this.clock.now() + delay
        this.emit({ event: "scheduled", ...context, nextAttemptAt: state.nextAt < state.expiresAt! ? state.nextAt : undefined,
          retryable: state.nextAt < state.expiresAt!, reason: succeeded ? "refresh" : "retry" })
        this.schedule(sessionID, state)
        this.notify(sessionID, state, "waiting")
      }
    }
  }
}
