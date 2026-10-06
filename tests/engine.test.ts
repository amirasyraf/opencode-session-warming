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

function finish(observation: Observation, ok: boolean) {
  const callback = observation.complete
  observation.complete = undefined
  callback?.(ok)
}

test("options reject invalid, unknown, ineffective and unsafe timer values", () => {
  assert.deepEqual(settings(), { enabled: true, intervalMs: 240000, durationMs: 3600000, debug: false })
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
