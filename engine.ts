import { randomUUID } from "node:crypto"
import { captureRequest, discardWarmResponse, retryAfterMs, warmRequest } from "./protocol.ts"
import type { Snapshot } from "./protocol.ts"
import type { Observation, Transport } from "./transport.ts"

export type Settings = { enabled: boolean; intervalMs: number; durationMs: number }
export type Diagnostic = { event: string; sessionID?: string; [key: string]: string | number | boolean | undefined }
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

export function settings(options: Record<string, unknown> = {}): Settings | undefined {
  if (Object.keys(options).some((key) => !["enabled", "intervalMs", "durationMs"].includes(key))) return
  const enabled = options.enabled ?? true
  const intervalMs = options.intervalMs ?? 240_000
  const durationMs = options.durationMs ?? 3_600_000
  if (typeof enabled !== "boolean" || typeof intervalMs !== "number" || typeof durationMs !== "number" ||
      !Number.isSafeInteger(intervalMs) || !Number.isSafeInteger(durationMs) ||
      intervalMs <= 0 || durationMs <= 0 || intervalMs > MAX_TIMER || durationMs > MAX_TIMER || intervalMs >= durationMs) return
  return { enabled, intervalMs, durationMs }
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
}

/** No task counters: only ordinary root-model transport activity matters. */
export class WarmingEngine {
  private states = new Map<string, State>()
  private disposed = false
  private config: Settings
  private http: Transport
  private log: (diagnostic: Diagnostic) => void
  private clock: Clock
  constructor(
    config: Settings,
    http: Transport,
    log: (diagnostic: Diagnostic) => void,
    clock: Clock = systemClock,
  ) {
    this.config = config
    this.http = http
    this.log = log
    this.clock = clock
  }

  has(sessionID: string) { return this.states.has(sessionID) }

  prepare(sessionID: string, capture: boolean): string | undefined {
    this.invalidate(sessionID, "ordinary-activity")
    if (this.disposed || !this.config.enabled || !capture) return
    const state: State = { token: randomUUID(), attempt: 0, active: false }
    this.states.set(sessionID, state)
    // Also expire preparation that never reaches the HTTP transport.
    state.expiresAt = this.clock.now() + this.config.durationMs
    this.http.register(state.token, (url, init) => this.start(sessionID, state, url, init))
    this.schedule(sessionID, state)
    return state.token
  }

  invalidate(sessionID: string, reason: string) {
    const state = this.states.get(sessionID)
    if (!state) return
    this.states.delete(sessionID)
    if (state.timer !== undefined) this.clock.clear(state.timer)
    state.warm?.abort()
    if (state.pending) state.pending.complete = undefined
    state.pending = undefined
    state.snapshot = undefined
    this.http.remove(state.token)
    this.emit({ event: "stopped", sessionID, reason })
  }

  dispose() {
    this.disposed = true
    for (const id of this.states.keys()) this.invalidate(id, "disposed")
  }

  private emit(diagnostic: Diagnostic) {
    try { this.log(diagnostic) } catch { /* Diagnostics never control session behavior. */ }
  }

  private current(sessionID: string, state: State) {
    return !this.disposed && this.states.get(sessionID) === state
  }

  private start(sessionID: string, state: State, url: string, init: RequestInit) {
    if (!this.current(sessionID, state)) return
    if (state.expiresAt !== undefined && this.clock.now() >= state.expiresAt) {
      this.invalidate(sessionID, "expired"); return
    }
    state.warm?.abort()
    state.warm = undefined
    if (state.pending) state.pending.complete = undefined
    state.pending = undefined
    state.snapshot = undefined
    state.active = true
    const attempt = ++state.attempt
    const now = this.clock.now()
    state.expiresAt = now + this.config.durationMs
    state.nextAt = now + this.config.intervalMs
    const snapshot = captureRequest(url, init)
    if (!snapshot) { this.invalidate(sessionID, "unsupported-request"); return }
    this.schedule(sessionID, state)
    const observation: Observation = { complete: (ok: boolean) => {
      if (!this.current(sessionID, state) || attempt !== state.attempt) return
      state.pending = undefined
      state.active = false
      if (this.clock.now() >= state.expiresAt!) { this.invalidate(sessionID, "expired"); return }
      if (ok) {
        state.snapshot = snapshot
        this.emit({ event: "captured", sessionID, model: String(snapshot.body.model) })
      }
      // Leave registration alive for ordinary transport retries using the same marker.
      this.schedule(sessionID, state)
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
      void this.warm(sessionID, state)
    }, Math.max(0, deadline - now))
  }

  private async warm(sessionID: string, state: State) {
    if (!this.current(sessionID, state) || state.active || state.warm || !state.snapshot) return
    const controller = new AbortController()
    state.warm = controller
    this.schedule(sessionID, state) // Keep the absolute deadline active during a warm request.
    const timeout = this.clock.set(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, state.expiresAt! - this.clock.now()))
    const startedAt = this.clock.now()
    let delay = this.config.intervalMs
    this.emit({ event: "warm-started", sessionID })
    try {
      const response = await this.http.fetch(state.snapshot.url, warmRequest(state.snapshot, controller.signal))
      if ([400, 401, 403, 422].includes(response.status)) {
        await response.body?.cancel()
        if (this.current(sessionID, state) && state.warm === controller) this.invalidate(sessionID, `http-${response.status}`)
        return
      }
      if (!response.ok) {
        if (response.status === 429) delay = Math.max(delay, retryAfterMs(response.headers.get("retry-after"), this.clock.now()))
        await response.body?.cancel()
        this.emit({ event: "warm-failed", sessionID, status: response.status })
      } else {
        const usage = await discardWarmResponse(response, controller.signal)
        this.emit({ event: "warm-completed", sessionID, elapsedMs: this.clock.now() - startedAt,
          inputTokens: usage?.inputTokens, cachedTokens: usage?.cachedTokens, outputTokens: usage?.outputTokens })
      }
    } catch {
      this.emit({ event: controller.signal.aborted ? "warm-aborted" : "warm-failed", sessionID })
    } finally {
      this.clock.clear(timeout)
      if (this.current(sessionID, state) && state.warm === controller) {
        state.warm = undefined
        state.nextAt = this.clock.now() + delay
        this.schedule(sessionID, state)
      }
    }
  }
}
