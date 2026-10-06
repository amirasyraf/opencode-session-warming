import assert from "node:assert/strict"
import { test } from "node:test"
import { CAPTURE_HEADER, KEEPALIVE, captureRequest, classifyRequest, discardWarmResponse, retryAfterMs, warmRequest } from "../protocol.ts"
import { completedResponse, ordinary, requestBody } from "./helpers.ts"

test("replay preserves cache prefix, reasoning and tool definitions without request mutation", () => {
  const [url, init] = ordinary()
  const headers = new Headers(init.headers)
  headers.set(CAPTURE_HEADER, "opaque")
  headers.set("content-length", "999")
  headers.set("idempotency-key", "ordinary-only")
  init.headers = headers
  const snapshot = captureRequest(url, init)!
  const controller = new AbortController()
  const warm = warmRequest(snapshot, controller.signal)
  const body = JSON.parse(warm.body as string)
  assert.deepEqual(body.input.slice(0, -1), requestBody.input)
  assert.equal(body.input.at(-1).content[0].text, KEEPALIVE)
  assert.deepEqual(body.tools, requestBody.tools)
  assert.deepEqual(body.reasoning, requestBody.reasoning)
  assert.equal(body.prompt_cache_key, requestBody.prompt_cache_key)
  assert.equal(body.tool_choice, "none")
  assert.equal(body.store, false)
  assert.equal(body.stream, true)
  assert.equal(warm.signal, controller.signal)
  assert.equal(new Headers(warm.headers).get(CAPTURE_HEADER), null)
  assert.equal(new Headers(warm.headers).get("content-length"), null)
  assert.equal(new Headers(warm.headers).get("idempotency-key"), null)
  assert.equal(headers.get(CAPTURE_HEADER), "opaque")
  assert.deepEqual(JSON.parse(init.body as string), requestBody)
})

test("only standalone Codex text requests with function tools qualify", () => {
  const [url, init] = ordinary()
  for (const changes of [
    { previous_response_id: null }, { conversation: "conv" }, { prompt: { id: "prompt" } },
    { background: true }, { stream: false }, { modalities: ["audio"] },
    { tools: [{ type: "web_search" }] }, { tools: [{ type: "unknown" }] },
    { input: [{ type: "item_reference", id: "state" }] },
    { input: [{ role: "user", content: [{ type: "input_image", image_url: "remote" }] }] },
  ]) assert.equal(captureRequest(url, { ...init, body: JSON.stringify({ ...requestBody, ...changes }) }), undefined)
  assert.equal(captureRequest("https://api.openai.com/v1/responses", init), undefined)
  assert.equal(captureRequest(url, { ...init, headers: {} }), undefined)
  assert.equal(captureRequest(url, { ...init, body: "invalid JSON" }), undefined)
  assert.equal(captureRequest(url, { ...init, body: new ReadableStream() }), undefined)
})

test("warm response parses split CRLF metadata and treats missing usage as unknown", async () => {
  const data = new TextEncoder().encode('data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"input_tokens_details":{"cached_tokens":8},"output_tokens":1}}}\r\n\r\n')
  const response = new Response(new ReadableStream({ start(c) {
    c.enqueue(data.slice(0, 3)); c.enqueue(data.slice(3, data.length - 1)); c.enqueue(data.slice(-1)); c.close()
  } }), { headers: { "content-type": "text/event-stream" } })
  assert.deepEqual(await discardWarmResponse(response, new AbortController().signal), { inputTokens: 10, cachedTokens: 8, outputTokens: 1 })
  assert.equal(await discardWarmResponse(completedResponse(null), new AbortController().signal), undefined)
})

test("successful JSON and empty responses are valid warm completions", async () => {
  const json = new Response(JSON.stringify({ usage: { input_tokens: 12, output_tokens: 1,
    input_tokens_details: { cached_tokens: 10 } } }), { headers: { "content-type": "application/json" } })
  assert.deepEqual(await discardWarmResponse(json, new AbortController().signal), { inputTokens: 12, cachedTokens: 10, outputTokens: 1 })
  assert.deepEqual(await discardWarmResponse(new Response(null, { status: 200 }), new AbortController().signal), undefined)
})

test("warm stream error, truncation, oversized frame and abort are failures", async () => {
  for (const body of [
    'data: {"type":"response.failed"}\n\n',
    'data: {"type":"response.created"}\n\n',
    'data: {"type":"response.completed"}\n\ndata: {"type":"error"}\n\n',
    "data: " + "x".repeat(1024 * 1024 + 1),
  ]) await assert.rejects(discardWarmResponse(new Response(body, { headers: { "content-type": "text/event-stream" } }), new AbortController().signal))
  const controller = new AbortController()
  const response = new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } })
  const promise = discardWarmResponse(response, controller.signal)
  controller.abort()
  await assert.rejects(promise)
})

test("Retry-After handles seconds, HTTP dates and malformed values", () => {
  assert.equal(retryAfterMs("3", 0), 3000)
  assert.equal(retryAfterMs("Thu, 01 Jan 1970 00:00:04 GMT", 1000), 3000)
  assert.equal(retryAfterMs("invalid", 0), 0)
})

test("request and SSE-frame limits count multibyte UTF-8 bytes", async () => {
  const body = { ...requestBody, input: [{ role: "user", content: "é".repeat(9 * 1024 * 1024) }] }
  const [url, init] = ordinary(body)
  assert.ok((init.body as string).length < 16 * 1024 * 1024)
  assert.equal(captureRequest(url, init), undefined)
  const frame = `data: ${JSON.stringify({ type: "response.completed", ignored: "é".repeat(600 * 1024) })}\n\n`
  assert.ok(frame.length < 1024 * 1024)
  await assert.rejects(discardWarmResponse(new Response(frame, { headers: { "content-type": "text/event-stream" } }),
    new AbortController().signal), /warm-frame-too-large/)
})

test("unsupported capture shapes report specific reasons without their content", () => {
  const [url, init] = ordinary()
  assert.equal(classifyRequest("https://api.openai.com/v1/responses", init).reason, "unsupported-endpoint")
  assert.equal(classifyRequest(url, { ...init, body: JSON.stringify({ ...requestBody, tools: [{ type: "web_search" }] }) }).reason, "unsupported-tools")
  assert.equal(classifyRequest(url, { ...init, body: JSON.stringify({ ...requestBody, conversation: "secret-conversation" }) }).reason, "stateful-request")
  assert.equal(classifyRequest(url, { ...init, body: "secret-invalid-json" }).reason, "invalid-json-or-headers")
})
