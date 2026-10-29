import assert from "node:assert/strict"
import { test } from "node:test"
import { capture, supportsModel } from "../adapters.ts"
import { GPT_INTERVAL_MS, initialProfile, modernClaude, modernGPT, resolvePolicy, settings } from "../cache-policy.ts"
import { CODEX_ENDPOINT } from "../protocol.ts"
import { imageURL, requestBody } from "./helpers.ts"

const signal = () => new AbortController().signal
const init = (body: unknown): RequestInit => ({ method: "POST", headers: { authorization: "Bearer fixture-only",
  "content-type": "application/json", "x-initiator": "user", "x-github-api-version": "2026-06-01", "idempotency-key": "original" }, body: JSON.stringify(body) })
const context = (providerID = "github-copilot", modelID = "gpt-5.6-sol") => ({ providerID, modelID })
const claude = (model = "claude-sonnet-5") => ({ model, stream: true, max_tokens: 8192,
  system: [{ type: "text", text: "Stable instructions", cache_control: { type: "ephemeral", ttl: "1h" } }],
  tools: [{ name: "read", description: "Read a file", input_schema: { type: "object", properties: {} } }],
  tool_choice: { type: "auto" }, thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" },
  messages: [{ role: "user", content: [{ type: "text", text: "Read this screenshot", cache_control: { type: "ephemeral", ttl: "5m" } },
     { type: "image", source: { type: "base64", media_type: "image/png", data: imageURL.split(",")[1] } },
     { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQK" } }] },
  { role: "assistant", content: [{ type: "thinking", thinking: "previous reasoning", signature: "fixture-signature" },
    { type: "tool_use", id: "call", name: "read", input: {} }] },
   { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: [
     { type: "text", text: "result" }, { type: "image", source: { type: "base64", media_type: "image/png", data: imageURL.split(",")[1] } },
     { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQK" } }] }] }] })

test("numeric model floors admit GPT/Claude target families without substring matches", () => {
  for (const id of ["gpt-5.6", "gpt-5.6-sol", "gpt-5.10", "gpt-6", "gpt-6.1-sol", "gpt-5.6-2026-07-01"]) assert.ok(modernGPT(id), id)
  for (const id of ["gpt-5.5", "gpt-5-mini", "fake-gpt-6", "gpt-5o", "gpt-5.6/other"]) assert.equal(modernGPT(id), false, id)
  for (const id of ["claude-sonnet-5", "claude-opus-5.5", "claude-opus-5-5", "claude-sonnet-6", "claude-sonnet-5-20260701",
    "claude-haiku-5.5", "claude-haiku-5-5", "claude-haiku-5.10", "claude-haiku-6", "claude-haiku-5-5-20261001"]) assert.ok(modernClaude(id), id)
  for (const id of ["claude-haiku-4.5", "claude-haiku-5", "claude-haiku-5.4", "claude-haiku-5-4", "claude-haiku-5-20261001",
    "claude-opus-4.8", "fake-claude-sonnet-5", "fake-claude-haiku-5.5", "claude-haiku-5.5/other"]) assert.equal(modernClaude(id), false, id)
  assert.equal(supportsModel(context("other")), false)
  assert.equal(supportsModel(context("github-copilot", "claude-opus-4.8")), false)
})

test("public API native prewarm preserves input, tools, reasoning and cache breakpoints", async () => {
  const body = { ...requestBody, model: "gpt-5.6-sol", prompt_cache_options: { ttl: "30m", mode: "implicit" },
    input: [{ role: "user", content: [{ type: "input_image", image_url: imageURL },
      { type: "input_text", text: "Inspect", prompt_cache_breakpoint: { mode: "explicit" } },
      { type: "input_file", filename: "notes.txt", file_data: "data:text/plain;base64,c2VjcmV0" }] }] }
  const original = init(body)
  const result = capture(context("openai"), "https://api.openai.com/v1/responses", original)
  assert.ok(result.replay)
  const warm = JSON.parse(result.replay.request(signal()).body as string)
  assert.deepEqual(warm, { ...body, stream: false, store: false, prompt_cache_options: { ...body.prompt_cache_options, prewarm: true } })
  assert.equal(original.body, JSON.stringify(body))
  assert.equal(result.replay.automatic.ttlEvidence, "documented")
  assert.equal(result.replay.automatic.intervalMs, GPT_INTERVAL_MS)
  const usage = await result.replay.drain(new Response(JSON.stringify({ object: "response", status: "completed", usage: {
    input_tokens: 1500, input_tokens_details: { cached_tokens: 1400, cache_write_tokens: 100 }, output_tokens: 0 } })), signal())
  assert.equal(usage?.cacheWriteTokens, 100)
  for (const body of ["", "{}", '{"status":"in_progress"}', '{"error":{"message":"secret"}}']) {
    await assert.rejects(result.replay.drain(new Response(body), signal()))
  }
})

test("Copilot GPT keeps the prefix and headers; rejection never escalates to an unbounded strategy", async () => {
  const body = { ...requestBody, model: "gpt-6.1-sol", max_output_tokens: 50,
    input: [{ role: "user", content: [{ type: "input_text", text: "Read this file" },
      { type: "input_file", file_id: "provider-file" }] }] }
  const original = init(body)
  const result = capture(context("github-copilot", body.model), "https://api.githubcopilot.com/responses", original)
  assert.ok(result.replay)
  const request = result.replay.request(signal())
  assert.deepEqual(JSON.parse(request.body as string), { ...body, tool_choice: "none", store: false })
  assert.equal(new Headers(request.headers).get("x-initiator"), "agent")
  assert.equal(new Headers(original.headers).get("x-initiator"), "user")
  assert.equal(new Headers(request.headers).get("authorization"), "Bearer fixture-only")
  assert.equal(new Headers(request.headers).has("idempotency-key"), false)
  const limited = { object: "response", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 100, output_tokens: 50 } }
  assert.equal((await result.replay.drain(new Response(`data: ${JSON.stringify({ type: "response.incomplete", response: limited })}\n\n`), signal()))?.outputLimitReached, true)
  limited.incomplete_details.reason = "content_filter"
  await assert.rejects(result.replay.drain(new Response(JSON.stringify(limited)), signal()))
  assert.equal(capture(context(), "https://api.githubcopilot.com/responses?other=1", init({ ...requestBody, model: "gpt-5.6-sol" })).reason, "unsupported-endpoint")
  assert.equal(capture(context("openai"), "https://api.githubcopilot.com/responses", init(body)).reason, "unsupported-endpoint")
})

test("Codex retains the legacy strategy but newer models resolve a 28-minute interval", () => {
  const result = capture(context("openai"), CODEX_ENDPOINT, init({ ...requestBody, model: "gpt-5.6-sol" }))
  assert.ok(result.replay)
  assert.equal(result.replay.strategy, "keepalive")
  assert.equal(result.replay.automatic.intervalMs, GPT_INTERVAL_MS)
  assert.equal(result.replay.automatic.ttlEvidence, "upstream-assumed")
  assert.equal(capture(context("openai", "gpt-5.5"), "https://api.openai.com/v1/responses", init({ ...requestBody, model: "gpt-5.5" })).reason, "unsupported-model")
})

for (const model of ["claude-sonnet-5", "claude-haiku-5.5", "claude-haiku-5-5"]) test(`${model} preserves images, signatures, tool selection, thinking and mixed TTLs`, async () => {
  const body = claude(model)
  assert.ok(supportsModel(context("github-copilot", model)))
  assert.deepEqual(initialProfile(model), { intervalMs: 240000, ttlMs: 300000, ttlEvidence: "upstream-assumed" })
  const result = capture(context("github-copilot", body.model), "https://api.githubcopilot.com/v1/messages", init(body))
  assert.ok(result.replay)
  assert.deepEqual(JSON.parse(result.replay.request(signal()).body as string), { ...body, max_tokens: 128 })
  assert.equal(result.replay.automatic.ttlMs, 300000)
  assert.equal(result.replay.automatic.intervalMs, 240000)
  const events = [
    { type: "message_start", message: { type: "message", usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 }, output_tokens: 0 } } },
    { type: "content_block_start", content_block: { type: "tool_use", name: "read", input: {} } },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } },
    { type: "message_stop" },
  ]
  const sse = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("")
  const bytes = new TextEncoder().encode(sse)
  const response = new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
    controller.close()
  } }), { headers: { "content-type": "application/json" } })
  const usage = await result.replay.drain(response, signal())
  assert.equal(usage?.inputTokens, 1110)
  assert.equal(usage?.cachedTokens, 1000)
  assert.equal(usage?.cacheWriteTokens, 100)
  assert.equal(usage?.outputTokens, 12)
  await assert.rejects(result.replay.drain(new Response(sse.replace('data: {"type":"message_stop"}\r\n\r\n', "")), signal()), /stream-truncated/)
  await assert.rejects(result.replay.drain(new Response(sse + 'data: {"type":"error","error":{"message":"private"}}\n\n'), signal()), /stream-failed/)
  const long = { ...body, messages: [{ role: "user", content: "Hello" }] }
  const oneHour = capture(context("github-copilot", body.model), "https://api.githubcopilot.com/v1/messages", init(long)).replay!
  assert.equal(oneHour.automatic.ttlMs, 3600000)
  assert.equal(oneHour.automatic.intervalMs, 3480000)
})

for (const model of ["claude-sonnet-5", "claude-haiku-5.5", "claude-haiku-5-5"]) test(`${model} unsupported shapes fail closed without leaking data`, () => {
  const body = claude(model)
  for (const [change, reason] of [
    [{ thinking: { type: "enabled", budget_tokens: 2048 } }, "unsupported-thinking-budget"],
    [{ tools: [{ type: "web_search_20250305", name: "web_search" }] }, "unsupported-tools"],
    [{ container: "secret-state" }, "unsupported-request-field"],
    [{ max_tokens: 0 }, "unsupported-output-limit"],
    [{ messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "secret-url" } }] }] }, "unsupported-input-image"],
    [{ cache_control: { type: "ephemeral", ttl: "24h" } }, "unsupported-cache-control"],
  ] as const) {
    const result = capture(context("github-copilot", body.model), "https://api.githubcopilot.com/v1/messages", init({ ...body, ...change }))
    assert.equal(result.reason, reason)
    assert.equal(JSON.stringify(result).includes("secret"), false)
  }
  assert.equal(capture(context("github-copilot", "claude-opus-5"), "https://api.githubcopilot.com/v1/messages", init(body)).reason, "model-mismatch")
})

test("Haiku uses only Copilot Messages and preserves disabled thinking", () => {
  const body = { ...claude("claude-haiku-5.5"), thinking: { type: "disabled" } }
  for (const host of ["https://api.githubcopilot.com", "https://api.individual.githubcopilot.com", "https://api.business.githubcopilot.com"]) {
    const result = capture(context("github-copilot", body.model), `${host}/v1/messages`, init(body))
    assert.ok(result.replay, host)
    assert.equal(result.replay.strategy, "bounded-replay")
    assert.deepEqual(JSON.parse(result.replay.request(signal()).body as string), { ...body, max_tokens: 128 })
    assert.equal(capture(context("github-copilot", body.model), `${host}/responses`, init(body)).reason, "unsupported-endpoint")
  }
  for (const model of ["claude-haiku-4.5", "claude-haiku-5", "claude-haiku-5.4"]) {
    assert.equal(supportsModel(context("github-copilot", model)), false, model)
    assert.equal(capture(context("github-copilot", model), "https://api.githubcopilot.com/v1/messages", init({ ...body, model })).reason, "unsupported-model", model)
  }
  assert.equal(supportsModel(context("anthropic", body.model)), false)
  assert.equal(capture(context("openai", body.model), "https://api.openai.com/v1/responses", init(body)).reason, "unsupported-model")
  assert.equal(capture(context("github-copilot", body.model), "https://api.enterprise.githubcopilot.com/v1/messages", init(body)).reason, "unsupported-endpoint")
})

for (const model of ["claude-sonnet-5.5", "claude-opus-5.5", "claude-haiku-5.5"]) test(`${model} preserves native system and effort updates in the complete replay prefix`, () => {
  // Wire forms from @opencode/ai's Anthropic Messages lowerNativeSystemUpdate / lowerMessages.
  const body = { ...claude(model), messages: [
    ...claude(model).messages,
    { role: "system", content: [{ type: "text", text: "Updated instructions", cache_control: { type: "ephemeral", ttl: "5m" } }] },
    { role: "system", content: [], output_config: { effort: "max" } },
    { role: "assistant", content: [{ type: "text", text: "Continuing" }] },
    { role: "user", content: [{ type: "text", text: "Continue" }] },
    { role: "system", content: [{ type: "text", text: "Further instructions" }], output_config: { effort: "low" } },
  ] }
  const original = init(body)
  const result = capture(context("github-copilot", model), "https://api.githubcopilot.com/v1/messages", original)
  assert.ok(result.replay, result.reason ?? "native system updates are replayable")
  assert.deepEqual(JSON.parse(result.replay.request(signal()).body as string), { ...body, max_tokens: 128 })
  assert.equal(original.body, JSON.stringify(body))
  assert.equal(result.replay.automatic.intervalMs, 240000)
  // A marker on an in-band system update participates in TTL selection, not just body.system.
  const onlySystemMarker = { ...body, messages: [
    { role: "user", content: "Continue" },
    { role: "system", content: [{ type: "text", text: "Updated instructions", cache_control: { type: "ephemeral", ttl: "5m" } }] },
  ] }
  assert.equal(capture(context("github-copilot", model), "https://api.githubcopilot.com/v1/messages", init(onlySystemMarker)).replay?.automatic.intervalMs, 240000)
})

test("native system updates reject unsupported content, fields, effort settings, and malformed cache markers", () => {
  const body = claude("claude-opus-5.5")
  for (const message of [
    { role: "system", content: "not a native text-block array" },
    { role: "system", content: null },
    { role: "system", content: [null] },
    { role: "system", content: [{ type: "text", text: 1 }] },
    { role: "system", content: [{ type: "tool_use", id: "call", name: "read", input: {} }] },
    { role: "system", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
    { role: "system", content: [], output_config: null },
    { role: "system", content: [], output_config: { effort: 1 } },
    { role: "system", content: [], output_config: { effort: "high", format: { type: "json_schema" } } },
    { role: "system", content: [], conversation: "secret-state" },
    { role: "user", content: [], output_config: { effort: "high" } },
    { role: "assistant", content: [], output_config: { effort: "high" } },
    { role: "developer", content: [] },
  ]) {
    assert.equal(capture(context("github-copilot", body.model), "https://api.githubcopilot.com/v1/messages",
      init({ ...body, messages: [...body.messages, message] })).reason, "unsupported-input-message")
  }
  const malformedCache = { role: "system", content: [{ type: "text", text: "Update", cache_control: { type: "ephemeral", ttl: "24h" } }] }
  assert.equal(capture(context("github-copilot", body.model), "https://api.githubcopilot.com/v1/messages",
    init({ ...body, messages: [...body.messages, malformedCache] })).reason, "unsupported-cache-control")
})

test("policy overrides are exact, independently inherited, validated and copied", () => {
  const options = { intervalMs: 300000, providers: { "github-copilot": { enabled: false, intervalMs: 250000,
    models: { "gpt-5.6-sol": { enabled: true, intervalMs: 200000 } } } } }
  const config = settings(options)!
  options.providers["github-copilot"].models["gpt-5.6-sol"].intervalMs = 1
  const auto = { intervalMs: 1680000, ttlMs: 1800000, ttlEvidence: "upstream-assumed" as const }
  const exact = resolvePolicy(config, "github-copilot", "gpt-5.6-sol", auto)
  assert.equal(exact.intervalMs, 200000)
  assert.equal(exact.intervalSource, "model")
  assert.equal(exact.enabled, true)
  assert.equal(resolvePolicy(config, "github-copilot", "gpt-6", auto).enabled, false)
  assert.equal(resolvePolicy(config, "openai", "gpt-6", auto).intervalSource, "global")
  assert.equal(resolvePolicy(settings()!, "openai", "gpt-6", auto).intervalMs, 1680000)
  assert.equal(resolvePolicy(settings()!, "github-copilot", "constructor", auto).enabled, true)
  for (const invalid of [{ providers: [] }, { models: { "gpt-6": {} } }, { providers: { "github-copilot": { ttlMs: 100 } } },
    { providers: { "github-copilot": { models: { "gpt-6/extra": {} } } } },
    { providers: { "github-copilot": { models: { "gpt-6": { intervalMs: Infinity } } } } },
    { providers: { openai: { enabled: "yes" } } }]) assert.equal(settings(invalid), undefined)
})

test("V2 Copilot plan hosts are accepted; enterprise and custom hosts stay unsupported; GPT-6.x stays eligible", () => {
  const body = { ...requestBody, model: "gpt-5.6-sol" }
  for (const host of ["https://api.individual.githubcopilot.com", "https://api.business.githubcopilot.com"]) {
    assert.ok(capture(context(), `${host}/responses`, init(body)).replay, host)
  }
  for (const host of ["https://api.enterprise.githubcopilot.com", "https://copilot-api.example.com"]) {
    assert.equal(capture(context(), `${host}/responses`, init(body)).reason, "unsupported-endpoint", host)
  }
  for (const id of ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"]) {
    assert.ok(supportsModel(context("openai", id)), id)
    const replay = capture(context("openai", id), CODEX_ENDPOINT, init({ ...requestBody, model: id })).replay!
    assert.equal(replay.adapterID, "codex")
    assert.equal(replay.automatic.intervalMs, GPT_INTERVAL_MS)
  }
})
