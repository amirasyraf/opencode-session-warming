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

function finish(observation: Observation, ok: boolean) {
  const callback = observation.complete
  observation.complete = undefined
  callback?.(ok)
}

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
