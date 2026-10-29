import assert from "node:assert/strict"
import { after, test } from "node:test"
import { setImmediate } from "node:timers/promises"
import { capture, supportsModel } from "../adapters.ts"
import { WarmingEngine } from "../engine.ts"
import { complete, observeResponse, readRequest, transport } from "../transport.ts"
import type { Observation } from "../transport.ts"
import type { Diagnostic } from "../diagnostics.ts"
import type { WarmStatus } from "../status.ts"
import { FakeClock } from "./helpers.ts"
import { decode, encodings, expectedReplay, isClaude, providers, requestFor, scenarios, serialize, terminal } from "./provider-fixtures.ts"
import type { Body, ContentEncoding, ProviderCase } from "./provider-fixtures.ts"

// Serializer contracts must never obtain credentials, resolve attachments, or make live network requests.
const originalFetch = globalThis.fetch
globalThis.fetch = (() => { throw new Error("Provider contracts must not use the network") }) as typeof fetch
after(() => { globalThis.fetch = originalFetch })

async function admit(provider: ProviderCase, body: Body, encoding?: ContentEncoding) {
  const original = requestFor(provider, body, encoding)
  const bytes = new Uint8Array(await original.clone().arrayBuffer())
  const read = await readRequest(original)
  assert.ok(!("reason" in read), "host wire request can be decoded")
  const result = capture(provider, read.url, read.init)
  assert.ok(result.replay, `${provider.name}: ${result.reason ?? "replay missing"}`)
  assert.equal(original.bodyUsed, false, "capture does not consume ordinary traffic")
  assert.deepEqual(new Uint8Array(await original.clone().arrayBuffer()), bytes, "ordinary bytes remain unchanged")
  return { original, replay: result.replay }
}

for (const provider of providers) {
  for (const scenario of scenarios) test(`serializer accepts ${provider.name}: ${scenario}`, async () => {
    const body = await serialize(provider, scenario)
    assert.ok(supportsModel(provider), "model eligibility agrees with the supported adapter")
    const frozen = JSON.stringify(body)
    // Guard fixture reachability: the source serializer must actually emit each feature we claim to exercise.
    if (scenario === "updates" || scenario === "combined") {
      const input = (isClaude(provider) ? body.messages : body.input) as Body[]
      assert.ok(input.some((item) => isClaude(provider) ? item.role === "system" : item.role === "developer"), "native instruction update is present")
      assert.ok(input.some((item) => isClaude(provider) ? item.output_config !== undefined : item.type === "configuration_update"), "native effort update is present")
    }
    if (scenario === "tools" || scenario === "combined") {
      assert.ok(JSON.stringify(body).includes("fixture-call"), "tool call and result survived serialization")
      assert.ok(JSON.stringify(body).includes("fixture-signature"), "reasoning/signature survived serialization")
    }
    if (scenario === "attachments" || scenario === "combined") {
      assert.ok(JSON.stringify(body).includes("JVBERi0xLjQK"), "PDF bytes survived serialization")
      assert.ok(JSON.stringify(body).includes("image/png"), "image bytes survived serialization")
    }
    for (const encoding of encodings) {
      const { original, replay } = await admit(provider, body, encoding)
      assert.equal(replay.strategy, provider.strategy)
      const controller = new AbortController()
      const warm = replay.request(controller.signal)
      assert.deepEqual(decode(warm), expectedReplay(provider, body), `${encoding ?? "plain"}: complete replay, not only a selected prefix field`)
      assert.equal(warm.signal, controller.signal)
      const headers = new Headers(warm.headers)
      assert.equal(headers.get("authorization"), original.headers.get("authorization"))
      assert.equal(headers.get("content-encoding"), encoding ?? null)
      assert.equal(headers.has("idempotency-key"), false)
      assert.equal(headers.get("x-initiator"), provider.providerID === "github-copilot" ? "agent" : "user")
      assert.equal(original.headers.get("x-initiator"), "user")
      assert.equal(original.headers.get("idempotency-key"), "ordinary-only")
    }
    assert.equal(JSON.stringify(body), frozen, "the serializer output itself is not mutated")
  })

  test(`response contracts ${provider.name}: terminal evidence, SSE framing, and usage`, async () => {
    const body = await serialize(provider)
    const { replay } = await admit(provider, body)
    for (const sse of [false, true]) for (const limited of [false, true]) {
      // Native prewarm expects normal completion; bounded output termination belongs to Copilot.
      if (limited && provider.strategy !== "bounded-replay") continue
      const response = terminal(provider, limited, sse)
      const usage = await replay.drain(response, new AbortController().signal)
      assert.equal(usage?.inputTokens, 100)
      assert.equal(usage?.cachedTokens, 90)
      assert.equal(usage?.outputTokens, 1)
      if (limited && provider.strategy === "bounded-replay") assert.equal(usage?.outputLimitReached, true)
    }
    for (const value of ["", "{}", 'data: {"type":"message_start","message":{"type":"message"}}\n\n',
      'data: {"type":"error","error":{"message":"fixture-private-error"}}\n\n']) {
      // Legacy Codex intentionally tolerates empty JSON; the strict adapters must not.
      if (provider.strategy === "keepalive" && (value === "" || value === "{}")) continue
      await assert.rejects(replay.drain(new Response(value), new AbortController().signal))
    }
  })

  test(`unsafe requests ${provider.name}: rejection leaves ordinary bytes intact`, async () => {
    const body = await serialize(provider)
    const patches: Array<[Body, string]> = [
      [{ previous_response_id: "fixture-state" }, "stateful-request"],
      [{ conversation: "fixture-state" }, "stateful-request"],
      [{ stream: false }, "non-streaming-request"],
      [{ background: true }, "server-background"],
      [{ model: "fixture-other-model" }, "model-mismatch"],
    ]
    if (isClaude(provider)) patches.push(
      [{ thinking: { type: "enabled", budget_tokens: 2048 } }, "unsupported-thinking-budget"],
      [{ tools: [{ type: "web_search_20250305", name: "search" }] }, "unsupported-tools"],
      [{ messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.invalid/private" } }] }] }, "unsupported-input-image"],
    )
    else patches.push(
      [{ tools: [{ type: "web_search" }] }, "unsupported-tools"],
      [{ input: [{ type: "item_reference", id: "fixture-state" }] }, "unsupported-input-item-reference"],
      [{ input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.invalid/private" }] }] }, "unsupported-input-image"],
    )
    for (const [patch, reason] of patches) {
      const invalid = { ...body, ...patch }
      const request = requestFor(provider, invalid)
      const read = await readRequest(request)
      assert.ok(!("reason" in read))
      const result = capture(provider, read.url, read.init)
      assert.equal(result.replay, undefined)
      assert.equal(result.reason, reason)
      assert.equal(request.bodyUsed, false)
      assert.deepEqual(await request.json(), invalid)
      assert.equal(JSON.stringify(result).includes("fixture-state"), false)
    }
    const valid = await readRequest(requestFor(provider, body))
    assert.ok(!("reason" in valid))
    assert.equal(capture(provider, `${provider.url}?other=1`, valid.init).reason, "unsupported-endpoint")
    assert.equal(capture({ ...provider, providerID: "unsupported" }, provider.url, valid.init).reason, "unsupported-provider")
  })
}

for (const provider of providers.filter(isClaude)) test(`cache and thinking ${provider.name}: actual serializer options survive`, async () => {
  for (const disabledThinking of [false, true]) for (const ttlSeconds of [300, 3600]) {
    // No effort marker while disabled: the host strips those before protocol serialization.
    const body = await serialize(provider, "tools", { disabledThinking, ttlSeconds })
    const { replay } = await admit(provider, body)
    assert.deepEqual(decode(replay.request(new AbortController().signal)), expectedReplay(provider, body))
    assert.equal(replay.automatic.intervalMs, ttlSeconds === 3600 ? 3480000 : 240000)
    assert.equal(replay.automatic.ttlMs, ttlSeconds * 1000)
    assert.equal(replay.automatic.ttlEvidence, "requested")
  }
})

async function lifecycle(provider: ProviderCase, fetcher: typeof fetch = (async () => terminal(provider, false)) as typeof fetch) {
  const body = await serialize(provider)
  const clock = new FakeClock()
  const http = transport()
  const requests: RequestInit[] = []
  const diagnostics: Diagnostic[] = []
  const statuses: WarmStatus[] = []
  http.fetch = (async (input, init) => { requests.push(init!); return fetcher(input, init) }) as typeof fetch
  const engine = new WarmingEngine({ enabled: true, intervalMs: 100, durationMs: 1000 }, http,
    (event) => diagnostics.push(event), clock, (status) => statuses.push(status))
  async function ordinary(nextBody = body): Promise<Observation> {
    const token = engine.prepare("fixture-root", true, provider)
    assert.ok(token)
    const request = requestFor(provider, nextBody, "zstd")
    const read = await readRequest(request)
    assert.ok(!("reason" in read))
    const observation = http.capture(token, read.url, read.init)
    assert.ok(observation, "serializer output reaches the engine's capture path")
    assert.equal(request.bodyUsed, false)
    return observation
  }
  return { body, clock, engine, http, requests, diagnostics, statuses, ordinary }
}

for (const provider of providers) {
  test(`lifecycle ${provider.name}: transport completion, stop/start, extension, expiry`, async () => {
    const h = await lifecycle(provider)
    try {
      const observation = await h.ordinary()
      await h.clock.advance(200)
      assert.equal(h.requests.length, 0, "ordinary transport is still generating")
      const response = observeResponse(terminal(provider, false, true), observation)
      await response.text()
      await h.clock.advance(0)
      assert.equal(h.requests.length, 1)
      assert.deepEqual(decode(h.requests[0]), expectedReplay(provider, h.body))
      assert.equal(h.statuses.at(-1)?.completed, 1)
      assert.equal(h.statuses.at(-1)?.failed, 0)
      assert.equal(h.engine.stop("fixture-root"), "stopped")
      const stopped = h.statuses.at(-1)!
      assert.equal(h.engine.extendWarming("fixture-root", 500), "extended")
      assert.equal(h.statuses.at(-1)?.startedAt, stopped.startedAt)
      assert.equal(h.statuses.at(-1)?.manualStopped, true)
      await h.clock.advance(200)
      assert.equal(h.requests.length, 1)
      assert.equal(h.engine.startWarming("fixture-root"), "started")
      assert.equal(h.statuses.at(-1)?.completed, 0, "manual start opens a fresh statistics window")
      await h.clock.advance(99)
      assert.equal(h.requests.length, 1)
      await h.clock.advance(1)
      assert.equal(h.requests.length, 2)
      assert.equal(h.engine.stop("fixture-root"), "stopped")
      await h.clock.advance(1000)
      assert.equal(h.engine.has("fixture-root"), false)
      assert.equal(h.statuses.at(-1)?.manualStopped, true, "expiry does not silently clear the user's stop preference")
      assert.equal(h.statuses.at(-1)?.nextAttemptAt, undefined)
      assert.equal(h.engine.startWarming("fixture-root"), "awaiting-activity", "expired input cannot be reconstructed")
      const metadata = JSON.stringify({ diagnostics: h.diagnostics, statuses: h.statuses })
      for (const secret of ["fixture-contract-only", "Fixture stable instructions", "Fixture updated instructions", "fixture-signature", "JVBERi0xLjQK"]) {
        assert.equal(metadata.includes(secret), false, "status and diagnostics remain metadata-only")
      }
    } finally { h.engine.dispose() }
  })

  test(`lifecycle ${provider.name}: cancellation is replayable but failure is not`, async () => {
    for (const [reason, replayable] of [["ordinary-aborted", true], ["ordinary-stream-error", false]] as const) {
      const h = await lifecycle(provider)
      try {
        const observation = await h.ordinary()
        complete(observation, false, { reason })
        await h.clock.advance(100)
        assert.equal(h.requests.length, replayable ? 1 : 0)
        assert.equal(h.statuses.at(-1)?.expiresAt, 1000)
      } finally { h.engine.dispose() }
    }
  })

  test(`lifecycle ${provider.name}: auth rejection releases input and never retries`, async () => {
    const h = await lifecycle(provider, (async () => new Response(null, { status: 401 })) as typeof fetch)
    try {
      complete(await h.ordinary(), true)
      await h.clock.advance(100)
      await h.clock.advance(500)
      assert.equal(h.requests.length, 1)
      assert.equal(h.engine.has("fixture-root"), false)
      assert.equal(h.statuses.at(-1)?.failed, 1)
      assert.equal(h.diagnostics.filter((event) => event.event === "warm-failed").length, 1)
    } finally { h.engine.dispose() }
  })

  test(`lifecycle ${provider.name}: late success cannot resurrect a replaced capture`, async () => {
    let resolve!: (value: Response) => void
    const h = await lifecycle(provider, (() => new Promise<Response>((done) => { resolve = done })) as typeof fetch)
    try {
      complete(await h.ordinary(), true)
      await h.clock.advance(100)
      assert.equal(h.requests.length, 1)
      const firstSignal = h.requests[0].signal!
      // A new ordinary request with an unsupported feature must invalidate the old warm even if capture fails.
      const token = h.engine.prepare("fixture-root", true, provider)!
      assert.equal(firstSignal.aborted, true)
      const read = await readRequest(requestFor(provider, { ...h.body, conversation: "fixture-state" }))
      assert.ok(!("reason" in read))
      assert.equal(h.http.capture(token, read.url, read.init), undefined)
      resolve(terminal(provider, false))
      await setImmediate()
      await h.clock.advance(500)
      assert.equal(h.engine.has("fixture-root"), false)
      assert.equal(h.requests.length, 1)
      const outcomes = h.diagnostics.filter((event) => ["warm-completed", "warm-failed", "warm-aborted"].includes(event.event))
      assert.equal(outcomes.length, 1, "one terminal outcome for the invalidated attempt")
      assert.equal(outcomes[0].event, "warm-aborted")
    } finally { h.engine.dispose() }
  })
}
