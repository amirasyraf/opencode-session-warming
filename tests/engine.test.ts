import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate } from "node:timers/promises"
import { WarmingEngine, settings } from "../engine.ts"
import type { Diagnostic, Settings } from "../engine.ts"
import type { Capture, Observation, Transport } from "../transport.ts"
import { FakeClock, completedResponse, ordinary } from "./helpers.ts"
import type { WarmStatus } from "../status.ts"

function harness(fetcher: typeof fetch = (async () => completedResponse()) as typeof fetch, config: Partial<Settings> = {}) {
  const clock = new FakeClock()
  const captures = new Map<string, Capture>()
  const requests: RequestInit[] = []
  const logs: Diagnostic[] = []
  const statuses: WarmStatus[] = []
  const http: Transport = {
    register: (token, capture) => { captures.set(token, capture) },
    remove: (token) => { captures.delete(token) },
    capture: (token, url, init) => captures.get(token)?.(url, init),
    fetch: (async (url, init) => { requests.push(init!); return fetcher(url, init) }) as typeof fetch,
  }
  const engine = new WarmingEngine({ enabled: true, intervalMs: 100, durationMs: 1000, ...config }, http,
    (log) => logs.push(log), clock, (status) => statuses.push(status))
  function start(id = "parent") {
    const token = engine.prepare(id, true)!
    const observation = captures.get(token)!(...ordinary())!
    return (ok: boolean) => finish(observation, ok)
  }
  return { engine, clock, captures, requests, logs, statuses, start }
}

test("long ordinary generation is overdue refresh, not a late wall-clock timer", async () => {
  const h = harness(undefined, { durationMs: 60000 })
  const done = h.start()
  await h.clock.advance(10000)
  done(true)
  await h.clock.advance(0)
  assert.equal(h.requests.length, 1)
  assert.equal(h.engine.has("parent"), true)
  assert.equal(h.logs.some((log) => log.reason === "clock-gap"), false)
  h.engine.dispose()
})

test("modern model defaults and failed retries have independent deadlines", async () => {
  let calls = 0
  const h = harness((async () => ++calls === 1 ? new Response(null, { status: 500 }) : completedResponse()) as typeof fetch,
    { intervalMs: undefined, durationMs: 3600000 })
  const token = h.engine.prepare("parent", true, { providerID: "openai", modelID: "gpt-5.6-sol" })!
  const [url, init] = ordinary()
  init.body = JSON.stringify({ ...JSON.parse(init.body as string), model: "gpt-5.6-sol" })
  finish(h.captures.get(token)!(url, init)!, true)
  assert.equal(h.statuses.at(-1)?.intervalMs, 1680000)
  assert.equal(h.statuses.at(-1)?.ttlEvidence, "upstream-assumed")
  await h.clock.advance(1680000)
  assert.equal(h.requests.length, 1)
  await h.clock.advance(29999)
  assert.equal(h.requests.length, 1)
  await h.clock.advance(1)
  assert.equal(h.requests.length, 2)
  assert.equal(h.statuses.at(-1)?.nextAttemptAt, 3390000)
  h.engine.dispose()
})

function finish(observation: Observation, ok: boolean, failure?: Parameters<NonNullable<Observation["complete"]>>[1]) {
  const callback = observation.complete
  observation.complete = undefined
  callback?.(ok, failure)
}

test("ordinary cancellation admits the captured input without extending the window", async () => {
  for (const reason of ["ordinary-aborted", "ordinary-stream-cancelled"]) {
    const h = harness()
    const token = h.engine.prepare("parent", true)!
    const observation = h.captures.get(token)!(...ordinary())!
    await h.clock.advance(150)
    assert.equal(h.requests.length, 0)
    finish(observation, false, { reason })
    assert.equal(h.statuses.at(-1)?.phase, "waiting")
    assert.equal(h.statuses.at(-1)?.expiresAt, 1000)
    assert.ok(h.logs.some((log) => log.event === "captured" && log.reason === reason))
    assert.equal(h.logs.find((log) => log.event === "captured")?.completedAt, undefined)
    await h.clock.advance(0)
    assert.equal(h.requests.length, 1)
    assert.equal(JSON.parse(h.requests[0]!.body as string).input[0].role, "user")
    await h.clock.advance(100)
    assert.equal(h.requests.length, 2)
    await h.clock.advance(750)
    assert.equal(h.engine.has("parent"), false)
    assert.equal(h.statuses.at(-1)?.phase, "expired")
  }
})

test("non-cancellation ordinary failures do not admit a replay", async () => {
  for (const reason of ["ordinary-fetch-error", "ordinary-stream-error", "ordinary-http-error", "observer-failed"]) {
    const h = harness()
    const token = h.engine.prepare("parent", true)!
    finish(h.captures.get(token)!(...ordinary())!, false, { reason })
    await h.clock.advance(500)
    assert.equal(h.requests.length, 0, reason)
    assert.equal(h.statuses.at(-1)?.phase, "stopped", reason)
    h.engine.dispose()
  }
})

test("options reject invalid, unknown, ineffective and unsafe timer values", () => {
  assert.deepEqual(settings(), { enabled: true, durationMs: 3600000, debug: false, journal: { enabled: true, retentionDays: 365 } })
  for (const options of [{ intervalMs: 0 }, { durationMs: Infinity }, { intervalMs: NaN },
    { durationMs: 2 ** 31 }, { intervalMs: 1.5 }, { intervalMs: 100, durationMs: 100 },
    { enabled: "yes" }, { debug: "yes" }, { interval: "4 minutes" }]) assert.equal(settings(options), undefined)
})

test("parent warms during a blocked foreground task, independently of child activity", async () => {
  const h = harness()
  const parentDone = h.start()
  await h.clock.advance(150)
  assert.equal(h.requests.length, 0, "no warming while parent HTTP is generating")
  parentDone(true) // HTTP completes; foreground task remains pending outside this engine.
  h.engine.prepare("child", false)
  await h.clock.advance(0)
  assert.equal(h.requests.length, 1)
  await h.clock.advance(100)
  assert.equal(h.requests.length, 2)
  await h.clock.advance(750)
  assert.equal(h.engine.has("parent"), false)
  assert.equal(h.captures.size, 0)
  assert.equal(h.clock.timers.size, 0)
})

test("failure attempts wait a full interval; 429 honors Retry-After", async () => {
  const h = harness((async () => new Response(null, { status: 429, headers: { "retry-after": "0.3" } })) as typeof fetch)
  h.start()(true)
  await h.clock.advance(100)
  assert.equal(h.requests.length, 1)
  await h.clock.advance(299)
  assert.equal(h.requests.length, 1)
  await h.clock.advance(1)
  assert.equal(h.requests.length, 2)
  h.engine.dispose()
})

test("non-retryable response stops until a fresh normal capture", async () => {
  for (const status of [400, 401, 403, 422]) {
    const h = harness((async () => new Response(null, { status })) as typeof fetch)
    h.start()(true)
    await h.clock.advance(100)
    assert.equal(h.engine.has("parent"), false)
    await h.clock.advance(500)
    assert.equal(h.requests.length, 1)
    h.start()(true)
    await h.clock.advance(100)
    assert.equal(h.requests.length, 2)
  }
})

test("new ordinary activity aborts warm requests even on unsupported provider", async () => {
  let signal: AbortSignal | undefined
  const h = harness((async (_url, init) => {
    signal = init!.signal!
    return new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
  }) as typeof fetch)
  h.start()(true)
  await h.clock.advance(100)
  h.engine.prepare("parent", false)
  assert.equal(signal?.aborted, true)
  await setImmediate()
  assert.equal(h.engine.has("parent"), false)
  assert.equal(h.clock.timers.size, 0)
})

test("deadline aborts in-flight warming and does not resurrect state", async () => {
  let signal: AbortSignal | undefined
  const h = harness((async (_url, init) => {
    signal = init!.signal!
    return new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
  }) as typeof fetch)
  h.start()(true)
  await h.clock.advance(1000)
  assert.equal(signal?.aborted, true)
  assert.equal(h.requests.length, 1)
  assert.equal(h.engine.has("parent"), false)
  assert.equal(h.clock.timers.size, 0)
})

test("retry marker survives failures; late attempts cannot overwrite newer capture", async () => {
  const h = harness()
  const token = h.engine.prepare("parent", true)!
  const capture = h.captures.get(token)!
  const first = capture(...ordinary())!
  const second = capture(...ordinary())!
  finish(first, true)
  await h.clock.advance(100)
  assert.equal(h.requests.length, 0)
  finish(second, false)
  const third = capture(...ordinary())!
  finish(third, true)
  await h.clock.advance(100)
  assert.equal(h.requests.length, 1)
  h.engine.invalidate("parent", "cancelled")
  finish(first, true); finish(third, true)
  await h.clock.advance(1000)
  assert.equal(h.requests.length, 1)
})

test("sleep-resume skips expired windows without catch-up requests", async () => {
  const h = harness()
  h.start()(true)
  h.clock.time = 2000
  for (const [, timer] of h.clock.timers) timer.callback()
  assert.equal(h.requests.length, 0)
  assert.equal(h.engine.has("parent"), false)
})

test("an overdue expiry is fenced when queried before its timer callback", () => {
  const h = harness()
  h.start()(true)
  h.clock.time = 1000
  assert.equal(h.engine.has("parent"), false)
  assert.equal(h.statuses.at(-1)?.phase, "expired")
  assert.equal(h.captures.size, 0)
})

test("sleep-resume invalidates a late active window without warming", async () => {
  const h = harness(undefined, { durationMs: 10000 })
  h.start()(true)
  h.clock.time = 6000
  const timers = [...h.clock.timers.values()]
  h.clock.timers.clear()
  for (const timer of timers) timer.callback()
  assert.equal(h.requests.length, 0)
  assert.equal(h.engine.has("parent"), false)
  assert.equal(h.statuses.at(-1)?.reason, "clock-gap")
  assert.equal(h.clock.timers.size, 0)
})

test("sleep-resume aborts an in-flight warm without scheduling a retry", async () => {
  let signal: AbortSignal | undefined
  const h = harness((async (_url, init) => {
    signal = init!.signal!
    return new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
  }) as typeof fetch, { durationMs: 60000 })
  h.start()(true)
  await h.clock.advance(100)
  h.clock.time = 12000
  const timers = [...h.clock.timers.values()]
  h.clock.timers.clear()
  for (const timer of timers) timer.callback()
  await setImmediate()
  assert.equal(signal?.aborted, true)
  assert.equal(h.engine.has("parent"), false)
  assert.equal(h.clock.timers.size, 0)
  assert.equal(h.requests.length, 1)
})

test("queued warm results cannot replace an overdue watchdog before its callback runs", async () => {
  for (const outcome of ["success", "http-failure", "network-failure", "body-completion"] as const) {
    let settle: () => void = () => {}
    const h = harness((async () => {
      if (outcome === "body-completion") {
        return new Response(new ReadableStream({ start(controller) {
          settle = () => {
            controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed"}\n\n'))
            controller.close()
          }
        } }), { headers: { "content-type": "text/event-stream" } })
      }
      return new Promise<Response>((resolve, reject) => {
        settle = () => outcome === "network-failure" ? reject(new TypeError("fixture failure")) :
          resolve(outcome === "http-failure" ? new Response(null, { status: 500 }) : completedResponse())
      })
    }) as typeof fetch, { durationMs: 60000 })
    h.start()(true)
    await h.clock.advance(100)
    h.clock.time = 20000 // Resume, but queued network continuation runs before overdue timers.
    settle()
    await setImmediate()
    assert.equal(h.engine.has("parent"), false, outcome)
    assert.equal(h.statuses.at(-1)?.reason, "clock-gap", outcome)
    assert.equal(h.logs.some((log) => log.event === "warm-completed"), false, outcome)
    assert.equal(h.clock.timers.size, 0, outcome)
    await h.clock.advance(30000)
    assert.equal(h.requests.length, 1, outcome)
  }
})

test("each root has independent timers and completed usage is observable", async () => {
  const h = harness()
  h.start("a")(true)
  await h.clock.advance(50)
  h.start("b")(true)
  await h.clock.advance(50)
  assert.equal(h.requests.length, 1)
  await h.clock.advance(50)
  assert.equal(h.requests.length, 2)
  assert.equal(h.logs.find((log) => log.event === "warm-completed")?.cachedTokens, 90)
  h.engine.dispose()
  assert.equal(h.captures.size, 0)
})

test("status accumulates provider usage and resets it for a new warming window", async () => {
  let response = 0
  const h = harness(async () => {
    response++
    return completedResponse({ input_tokens: response * 100, input_tokens_details: { cached_tokens: response * 60, cache_write_tokens: response * 10 }, output_tokens: response })
  })
  h.start()(true)
  await h.clock.advance(100)
  await h.clock.advance(100)
  assert.deepEqual(h.statuses.at(-1)?.usage, { inputTokens: 300, uncachedInputTokens: 90, cachedTokens: 180, cacheWriteTokens: 30, outputTokens: 3 })
  h.start()
  assert.equal(h.statuses.at(-1)?.usage, undefined)
  h.engine.dispose()
})

test("ordinary admitted usage is visible before the first warm request", () => {
  const h = harness()
  h.start()(true)
  h.engine.recordOrdinaryUsage("parent", { uncachedInputTokens: 10, cachedTokens: 90, outputTokens: 5 })
  assert.deepEqual(h.statuses.at(-1)?.usage, { uncachedInputTokens: 10, cachedTokens: 90, outputTokens: 5 })
  h.engine.dispose()
})

test("transport failures and unsupported bodies do not promote a snapshot", async () => {
  const h = harness()
  h.start()(false)
  await h.clock.advance(500)
  assert.equal(h.requests.length, 0)
  const token = h.engine.prepare("parent", true)!
  h.captures.get(token)!(...ordinary({ previous_response_id: "stateful" }))
  assert.equal(h.engine.has("parent"), false)
  h.engine.dispose()
})

test("invalidation releases pending capture ownership without cancelling ordinary traffic", async () => {
  for (const reason of ["expired", "disposed", "ordinary-activity"]) {
    const h = harness()
    const token = h.engine.prepare("parent", true)!
    const observation = h.captures.get(token)!(...ordinary())!
    assert.equal(typeof observation.complete, "function")
    if (reason === "expired") await h.clock.advance(1000)
    else if (reason === "disposed") h.engine.dispose()
    else h.engine.prepare("parent", false)
    assert.equal(observation.complete, undefined, "observer must no longer retain the engine or authenticated snapshot")
    finish(observation, true)
    await h.clock.advance(1000)
    assert.equal(h.requests.length, 0)
    assert.equal(h.captures.size, 0)
  }
})

test("logs correlate rate limits and expose their next retry time", async () => {
  const h = harness((async () => new Response(null, { status: 429,
    headers: { "retry-after": "0.3", "x-request-id": "provider-request" } })) as typeof fetch)
  h.start()(true)
  await h.clock.advance(100)
  const started = h.logs.find((entry) => entry.event === "warm-started")!
  const failed = h.logs.find((entry) => entry.event === "warm-failed")!
  assert.equal(failed.attemptID, started.attemptID)
  assert.equal(failed.reason, "http-rate-limit")
  assert.equal(failed.requestID, "provider-request")
  assert.equal(failed.status, 429)
  assert.equal(failed.nextAttemptAt, 400)
  h.engine.dispose()
})

test("every started warm has one terminal event even when a late response invalidates the window", async () => {
  let resolve!: (response: Response) => void
  const h = harness((() => new Promise<Response>((done) => { resolve = done })) as typeof fetch, { durationMs: 60000 })
  h.start()(true)
  await h.clock.advance(100)
  const started = h.logs.find((entry) => entry.event === "warm-started")!
  h.clock.time += 15000
  resolve(completedResponse())
  await setImmediate()
  const terminal = h.logs.filter((entry) => ["warm-completed", "warm-failed", "warm-aborted"].includes(entry.event))
  assert.equal(terminal.length, 1)
  assert.equal(terminal[0]!.event, "warm-aborted")
  assert.equal(terminal[0]!.reason, "clock-gap")
  assert.equal(terminal[0]!.attemptID, started.attemptID)
  assert.equal(terminal[0]!.windowID, started.windowID)
  assert.ok(started.windowID)
  h.engine.dispose()
})

test("nonretryable failures finalize before invalidation without a second aborted outcome", async () => {
  const h = harness((async () => new Response(null, { status: 401 })) as typeof fetch)
  h.start()(true)
  await h.clock.advance(100)
  assert.equal(h.logs.filter((entry) => entry.event === "warm-failed").length, 1)
  assert.equal(h.logs.filter((entry) => entry.event === "warm-aborted").length, 0)
  h.engine.dispose()
})

test("timeouts settle even with an uncooperative transport and identify the abort reason", async () => {
  const h = harness((async () => new Promise<Response>(() => {})) as typeof fetch)
  h.start()(true)
  await h.clock.advance(1000)
  const aborted = h.logs.find((entry) => entry.event === "warm-aborted")!
  assert.equal(aborted.reason, "expired")
  assert.equal(aborted.retryable, false)
  assert.equal(h.clock.timers.size, 0)
})

test("network and SSE failures have distinct safe diagnostic categories", async () => {
  const network = harness((async () => { throw new TypeError("secret URL and prompt", { cause: { code: "ENOTFOUND" } }) }) as typeof fetch)
  network.start()(true)
  await network.clock.advance(100)
  assert.equal(network.logs.find((entry) => entry.event === "warm-failed")?.errorCode, "ENOTFOUND")
  assert.equal(JSON.stringify(network.logs).includes("secret"), false)
  network.engine.dispose()
  const truncated = harness((async () => new Response('data: {"type":"response.created"}\n\n',
    { headers: { "content-type": "text/event-stream" } })) as typeof fetch)
  truncated.start()(true)
  await truncated.clock.advance(100)
  assert.equal(truncated.logs.find((entry) => entry.event === "warm-failed")?.errorCode, "stream-truncated")
  truncated.engine.dispose()
})

test("request timeout is distinct from expiry and retries only within the active window", async () => {
  const h = harness((async () => new Promise<Response>(() => {})) as typeof fetch, { durationMs: 60000 })
  h.start()(true)
  await h.clock.advance(30100)
  const aborted = h.logs.find((entry) => entry.event === "warm-aborted")!
  assert.equal(aborted.reason, "request-timeout")
  assert.equal(aborted.errorCategory, "timeout")
  assert.equal(aborted.retryable, true)
  assert.equal(aborted.nextAttemptAt, 30200)
  h.engine.dispose()
  assert.equal(h.clock.timers.size, 0)
})

test("engine publishes actual request progress, resets on ordinary activity and fences stale status", async () => {
  const h = harness()
  const complete = h.start()
  assert.equal(h.statuses.at(-1)?.phase, "generating")
  assert.equal(h.statuses.at(-1)?.attempted, 0)
  complete(true)
  assert.equal(h.statuses.at(-1)?.phase, "waiting")
  await h.clock.advance(100)
  assert.equal(h.statuses.at(-1)?.attempted, 1)
  assert.equal(h.statuses.at(-1)?.completed, 1)
  assert.equal(h.statuses.at(-1)?.marks[0].result, "completed")
  assert.equal(h.statuses.find((status) => status.phase === "sending")?.marks[0].result, "sending", "published snapshots are immutable")
  h.start()
  assert.equal(h.statuses.at(-1)?.attempted, 0)
  await h.clock.advance(1000)
  assert.equal(h.statuses.at(-1)?.phase, "expired")
  complete(true)
  assert.equal(h.statuses.at(-1)?.phase, "expired")
  h.engine.dispose()
})

test("user stop preserves a replay and start creates one fresh window without catch-up sends", async () => {
  const h = harness()
  h.start()(true)
  await h.clock.advance(100)
  const oldWindow = h.logs.find((entry) => entry.event === "window-started")?.windowID
  assert.equal(h.engine.stop("parent"), "stopped")
  const frozen = h.statuses.at(-1)!
  assert.equal(frozen.phase, "stopped")
  assert.equal(frozen.reason, "user-stop")
  assert.equal(frozen.manualStopped, true)
  assert.equal(frozen.nextAttemptAt, undefined)
  assert.equal(h.engine.stop("parent"), "already-stopped")
  await h.clock.advance(300)
  assert.equal(h.requests.length, 1)
  assert.equal(h.engine.startWarming("parent"), "started")
  const fresh = h.statuses.at(-1)!
  assert.equal(fresh.startedAt, 400)
  assert.equal(fresh.expiresAt, 1400)
  assert.equal(fresh.completed, 0)
  assert.equal(fresh.usage, undefined)
  assert.equal(fresh.manualStopped, false)
  assert.notEqual(h.logs.filter((entry) => entry.event === "window-started").at(-1)?.windowID, oldWindow)
  assert.equal(h.engine.startWarming("parent"), "already-started")
  assert.equal(h.statuses.at(-1)?.expiresAt, 1400)
  await h.clock.advance(99)
  assert.equal(h.requests.length, 1)
  await h.clock.advance(1)
  assert.equal(h.requests.length, 2)
  h.engine.dispose()
})

test("extension lengthens a live window without resetting state or manual stop", async () => {
  const h = harness()
  h.start()(true)
  await h.clock.advance(100)
  const windowID = h.logs.filter((entry) => entry.event === "window-started").at(-1)?.windowID
  const before = h.statuses.at(-1)!
  assert.equal(h.engine.extendWarming("parent", 250), "extended")
  const extended = h.statuses.at(-1)!
  assert.equal(extended.durationMs, 1250)
  assert.equal(extended.expiresAt, 1250)
  assert.equal(extended.startedAt, before.startedAt)
  assert.equal(extended.completed, 1)
  assert.equal(extended.marks.length, before.marks.length)
  assert.equal(extended.nextAttemptAt, before.nextAttemptAt, "the next warm target is unchanged")
  const record = h.logs.find((entry) => entry.event === "warming-extended")!
  assert.equal(record.durationMs, 250)
  assert.equal(record.reason, "user-extend")
  assert.equal(record.windowID, windowID)
  assert.equal(h.logs.filter((entry) => entry.event === "window-started").length, 1, "no fresh window")
  assert.equal(h.engine.extendWarming("parent"), "extended")
  assert.equal(h.statuses.at(-1)?.durationMs, 2250)
  h.engine.stop("parent")
  assert.equal(h.engine.extendWarming("parent", 100), "extended")
  assert.equal(h.statuses.at(-1)?.manualStopped, true)
  assert.equal(h.statuses.at(-1)?.expiresAt, 2350)
  assert.equal(h.engine.extendWarming("parent", 2_147_482_000), "duration-limit")
  assert.equal(h.statuses.at(-1)?.expiresAt, 2350)
  h.engine.dispose()
})

test("extension keeps warming past the original expiry but never resurrects expired state", async () => {
  const h = harness()
  h.start()(true)
  assert.equal(h.engine.extendWarming("parent", 500), "extended")
  await h.clock.advance(1200)
  assert.notEqual(h.statuses.at(-1)?.phase, "expired")
  assert.ok(h.requests.length >= 11)
  await h.clock.advance(300)
  assert.equal(h.statuses.at(-1)?.phase, "expired")
  assert.equal(h.engine.extendWarming("parent", 500), "awaiting-activity")
  assert.equal(h.statuses.at(-1)?.phase, "expired")
  h.engine.dispose()
  assert.equal(h.engine.extendWarming("parent"), "unavailable")
})

test("user stop survives new ordinary activity and captures the latest complete input", async () => {
  const h = harness()
  h.start()(true)
  h.engine.stop("parent")
  const token = h.engine.prepare("parent", true)!
  const updated = ordinary({ ...JSON.parse(ordinary()[1].body as string), input: [{ role: "user", content: "Latest input" }] })
  finish(h.captures.get(token)!(...updated)!, true)
  await h.clock.advance(300)
  assert.equal(h.requests.length, 0)
  assert.equal(h.statuses.at(-1)?.manualStopped, true)
  h.engine.startWarming("parent")
  await h.clock.advance(100)
  const input = JSON.parse(h.requests.at(-1)!.body as string).input
  assert.equal(input[0].content, "Latest input")
  h.engine.dispose()
})

test("stop and start during preparation or ordinary generation never cancel or overlap ordinary traffic", async () => {
  for (const stage of ["preparation", "generation"] as const) {
    const h = harness()
    const token = h.engine.prepare("parent", true)!
    const observation = stage === "generation" ? h.captures.get(token)!(...ordinary())! : undefined
    h.engine.stop("parent")
    assert.equal(h.engine.startWarming("parent"), stage === "generation" ? "started" : "awaiting-activity")
    await h.clock.advance(100)
    assert.equal(h.requests.length, 0)
    const pending = observation ?? h.captures.get(token)!(...ordinary())!
    assert.ok(pending.complete)
    finish(pending, true)
    await h.clock.advance(stage === "generation" ? 0 : 100)
    assert.equal(h.requests.length, 1)
    h.engine.dispose()
  }
})

test("stop aborts an in-flight warm exactly once and late completion cannot corrupt a restarted window", async () => {
  let signal!: AbortSignal
  let complete!: () => void
  const h = harness((async (_url, init) => {
    signal = init!.signal!
    return new Response(new ReadableStream({ start(controller) {
      complete = () => {
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"usage":{"input_tokens":999}}}\n\n'))
        controller.close()
      }
    } }), { headers: { "content-type": "text/event-stream" } })
  }) as typeof fetch)
  h.start()(true)
  await h.clock.advance(100)
  complete() // Queue stream completion before stop; its continuation must not update the fresh window.
  h.engine.stop("parent")
  assert.equal(signal.aborted, true)
  h.engine.startWarming("parent")
  await setImmediate()
  assert.equal(h.statuses.at(-1)?.usage, undefined)
  assert.equal(h.statuses.at(-1)?.completed, 0)
  assert.equal(h.statuses.at(-1)?.nextAttemptAt, 200)
  assert.equal(h.logs.filter((entry) => entry.event === "warm-aborted").length, 1)
  assert.equal(h.logs.filter((entry) => entry.event === "warm-completed").length, 0)
  h.engine.dispose()
})

test("start cannot resurrect expired, invalidated or clock-gap snapshots; deletion forgets manual stop", async () => {
  for (const reason of ["expired", "clock-gap", "reverted", "compacted", "http-401"] as const) {
    const h = harness(undefined, { durationMs: 60000 })
    h.start()(true)
    h.engine.stop("parent")
    if (reason === "expired") h.clock.time = 60000
    else if (reason === "clock-gap") h.clock.time = 11000
    else h.engine.invalidate("parent", reason)
    assert.equal(h.engine.startWarming("parent"), "awaiting-activity", reason)
    assert.equal(h.captures.size, 0, reason)
    await h.clock.advance(100)
    assert.equal(h.requests.length, 0, reason)
    assert.equal(h.statuses.at(-1)?.phase, "idle")
    h.engine.dispose()
  }
  const h = harness()
  h.engine.stop("parent")
  h.engine.forget("parent")
  h.start()(true)
  await h.clock.advance(100)
  assert.equal(h.requests.length, 1)
  h.engine.dispose()
})

test("stopped snapshot expiry still releases capture callbacks and leaves the session manually stopped", async () => {
  const h = harness()
  const done = h.start()
  h.engine.stop("parent")
  await h.clock.advance(1000)
  done(true)
  assert.equal(h.engine.has("parent"), false)
  assert.equal(h.captures.size, 0)
  assert.equal(h.statuses.at(-1)?.manualStopped, true)
  h.start()(true)
  await h.clock.advance(100)
  assert.equal(h.requests.length, 0)
  h.engine.dispose()
})

test("manual start never bypasses disabled provider policy or restores a failed capture", () => {
  const h = harness(undefined, { providers: { openai: { enabled: false } } })
  h.engine.stop("parent")
  assert.equal(h.engine.prepare("parent", true), undefined)
  assert.equal(h.engine.startWarming("parent"), "awaiting-activity")
  assert.equal(h.engine.prepare("parent", true), undefined)
  assert.equal(h.captures.size, 0)
  h.engine.dispose()
  const failed = harness()
  failed.start()(false)
  failed.engine.stop("parent")
  assert.equal(failed.engine.startWarming("parent"), "awaiting-activity")
  assert.equal(failed.statuses.at(-1)?.phase, "idle")
  failed.engine.dispose()
})

test("stopped preferences are bounded without silently re-enabling older sessions", () => {
  const h = harness()
  for (let index = 0; index < 1024; index++) assert.equal(h.engine.stop(`root-${index}`), "stopped")
  assert.equal(h.engine.stop("excess"), "busy")
  assert.equal(h.engine.stop("root-0"), "already-stopped")
  h.engine.forget("root-0")
  assert.equal(h.engine.stop("excess"), "stopped")
  h.engine.dispose()
})
