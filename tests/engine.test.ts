import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate } from "node:timers/promises"
import { WarmingEngine, settings } from "../engine.ts"
import type { Diagnostic } from "../engine.ts"
import type { Capture, Observation, Transport } from "../transport.ts"
import { FakeClock, completedResponse, ordinary } from "./helpers.ts"

function harness(fetcher: typeof fetch = (async () => completedResponse()) as typeof fetch) {
  const clock = new FakeClock()
  const captures = new Map<string, Capture>()
  const requests: RequestInit[] = []
  const logs: Diagnostic[] = []
  const http: Transport = {
    register: (token, capture) => { captures.set(token, capture) },
    remove: (token) => { captures.delete(token) },
    fetch: (async (url, init) => { requests.push(init!); return fetcher(url, init) }) as typeof fetch,
  }
  const engine = new WarmingEngine({ enabled: true, intervalMs: 100, durationMs: 1000 }, http, (log) => logs.push(log), clock)
  function start(id = "parent") {
    const token = engine.prepare(id, true)!
    const observation = captures.get(token)!(...ordinary())!
    return (ok: boolean) => finish(observation, ok)
  }
  return { engine, clock, captures, requests, logs, start }
}

function finish(observation: Observation, ok: boolean) {
  const callback = observation.complete
  observation.complete = undefined
  callback?.(ok)
}

test("options reject invalid, unknown, ineffective and unsafe timer values", () => {
  assert.deepEqual(settings(), { enabled: true, intervalMs: 240000, durationMs: 3600000 })
  for (const options of [{ intervalMs: 0 }, { durationMs: Infinity }, { intervalMs: NaN },
    { durationMs: 2 ** 31 }, { intervalMs: 1.5 }, { intervalMs: 100, durationMs: 100 },
    { enabled: "yes" }, { interval: "4 minutes" }]) assert.equal(settings(options), undefined)
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
