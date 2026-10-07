import assert from "node:assert/strict"
import { test } from "node:test"
import { CAPTURE_HEADER, KEEPALIVE, captureRequest, classifyRequest, discardWarmResponse, retryAfterMs, warmRequest } from "../protocol.ts"
import { completedResponse, imageURL, ordinary, requestBody } from "./helpers.ts"

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

test("only standalone Codex requests with recognized content and function tools qualify", () => {
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

test("screenshots in conversation history and function results preserve the entire replay prefix", () => {
  for (const detail of [undefined, null, "auto", "low", "high", "original"]) {
    const image = { type: "input_image", image_url: imageURL, detail }
    const body = { ...requestBody, input: [
      { role: "user", content: [{ type: "input_text", text: "Inspect this screenshot" }, image] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking it" }] },
      { type: "function_call", call_id: "call", name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: "call", output: [{ type: "input_text", text: "Tool screenshot" }, image] },
      { role: "user", content: "Continue after the screenshot" },
    ] }
    const [url, init] = ordinary(body)
    const result = classifyRequest(url, init)
    assert.equal(result.reason, undefined)
    const warm = JSON.parse(warmRequest(result.snapshot!, new AbortController().signal).body as string)
    assert.deepEqual(warm.input.slice(0, -1), JSON.parse(init.body as string).input)
    assert.equal(warm.input.at(-1).content[0].text, KEEPALIVE)
    assert.equal(warm.tool_choice, "none")
    assert.equal(warm.store, false)
    assert.deepEqual(JSON.parse(init.body as string), JSON.parse(JSON.stringify(body)))
  }
})

test("referenced, malformed and unsupported media are rejected with content-free reasons", () => {
  for (const part of [
    { type: "input_image", image_url: "https://example.com/private-image.png" },
    { type: "input_image", file_id: "private-file" },
    { type: "input_image", file_id: "private-file", image_url: imageURL },
    { type: "input_image", image_url: imageURL, detail: "unknown" },
    { type: "input_image", image_url: imageURL, detail: ["auto"] },
    { type: "input_image", image_url: "data:image/png;base64," },
    { type: "input_image", image_url: "data:image/png;base64,private-invalid-data" },
    { type: "input_image", image_url: "data:image/svg+xml;base64,PHN2Zz4=" },
    { type: "input_image", image_url: "file:///private-image.png" },
    { type: "input_file", file_data: "private-file-data" },
    { type: "input_audio", data: "private-audio-data" },
  ]) {
    for (const item of [
      { role: "user", content: [part] },
      { type: "function_call_output", call_id: "call", output: [part] },
    ]) {
      const [url, init] = ordinary({ ...requestBody, input: [item] })
      const result = classifyRequest(url, init)
      assert.equal(result.snapshot, undefined)
      assert.equal(result.reason, `unsupported-${part.type.replace("_", "-")}`)
      assert.equal(JSON.stringify(result).includes("private"), false)
    }
  }
})

test("all supported embedded image MIME types qualify and image bytes count toward the body limit", () => {
  for (const mime of ["png", "jpeg", "webp", "gif"]) {
    const [url, init] = ordinary({ ...requestBody, input: [{ role: "user", content: [
      { type: "input_image", image_url: imageURL.replace("image/png", `image/${mime}`) },
    ] }] })
    assert.ok(captureRequest(url, init), mime)
  }
  const largeImage = { type: "input_image", image_url: "data:image/png;base64," + "A".repeat(16 * 1024 * 1024) }
  const [url, init] = ordinary({ ...requestBody, input: [{ role: "user", content: [largeImage] }] })
  assert.equal(classifyRequest(url, init).reason, "request-too-large")
  for (const role of ["system", "developer", "assistant"]) {
    const [url, init] = ordinary({ ...requestBody, input: [{ role, content: [{ type: "input_image", image_url: imageURL }] }] })
    assert.equal(classifyRequest(url, init).reason, "unsupported-input-image")
  }
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

test("SSE format is detected with missing or misleading headers across split prefixes", async () => {
  for (const contentType of [undefined, "application/json", "text/plain", "application/octet-stream"]) {
    const body = new TextEncoder().encode(': keepalive\r\n\r\nevent: response.completed\r\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":1}}}\r\n\r\n')
    const response = new Response(new ReadableStream({ start(c) {
      for (const byte of body) c.enqueue(Uint8Array.of(byte))
      c.close()
    } }), { headers: contentType ? { "content-type": contentType } : {} })
    assert.deepEqual(await discardWarmResponse(response, new AbortController().signal),
      { inputTokens: 12, cachedTokens: undefined, outputTokens: 1 })
    const dataOnly = new Response('data: {"type":"response.completed"}\n\n',
      { headers: contentType ? { "content-type": contentType } : {} })
    assert.equal(await discardWarmResponse(dataOnly, new AbortController().signal), undefined)
  }
})

test("mislabelled SSE still rejects failed, truncated, malformed and oversized responses", async () => {
  for (const [body, code] of [
    ['data: {"type":"response.failed"}\n\n', "stream-failed"],
    ['data: {"type":"response.incomplete"}\n\n', "stream-incomplete"],
    ['data: {"type":"response.created"}\n\n', "stream-truncated"],
    ['data: invalid\n\n', "invalid-sse-json"],
    ['data: ' + "x".repeat(1024 * 1024 + 1), "warm-frame-too-large"],
    ['<html>bad gateway</html>', "invalid-warm-json"],
  ]) await assert.rejects(discardWarmResponse(new Response(body, { headers: { "content-type": "application/json" } }),
    new AbortController().signal), new RegExp(code!))
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

test("body detection and JSON reads remain abortable and response-size bounded", async () => {
  for (const prefix of ["da", '{"usage":']) {
    let cancelled = false
    const controller = new AbortController()
    const response = new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(prefix)) },
      cancel() { cancelled = true },
    }), { headers: { "content-type": "application/json" } })
    const promise = discardWarmResponse(response, controller.signal)
    controller.abort()
    await assert.rejects(promise)
    assert.equal(cancelled, true)
  }
  await assert.rejects(discardWarmResponse(new Response(" ".repeat(8 * 1024 * 1024 + 1)),
    new AbortController().signal), /warm-response-too-large/)
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
