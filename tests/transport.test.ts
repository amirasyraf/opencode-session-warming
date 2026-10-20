import assert from "node:assert/strict"
import { test } from "node:test"
import { gzipSync, zstdCompressSync } from "node:zlib"
import { observeResponse, readRequest, transport } from "../transport.ts"
import { MAX_BODY_BYTES } from "../protocol.ts"

test("response observer preserves bytes, status metadata and pull-based completion", async () => {
  const calls: boolean[] = []
  let pulls = 0
  const response = new Response(new ReadableStream({ pull(c) {
    pulls++
    if (pulls === 1) c.enqueue(new TextEncoder().encode("payload"))
    else c.close()
  } }, { highWaterMark: 0 }), { status: 200, statusText: "Original", headers: { "x-test": "yes" } })
  const observed = observeResponse(response, { complete: (ok) => { calls.push(ok) } })
  assert.equal(pulls, 0, "observer must not eagerly drain")
  assert.equal(observed.status, 200)
  assert.equal(observed.statusText, "Original")
  assert.equal(observed.headers.get("x-test"), "yes")
  assert.deepEqual(calls, [])
  assert.equal(await observed.text(), "payload")
  assert.deepEqual(calls, [true])
})

test("stream errors, cancellation and HTTP errors report failure once without changing the error", async () => {
  const calls: unknown[] = []
  const error = new Error("provider stream failed")
  const record = { complete: (ok: boolean, failure?: { reason?: string; status?: number }) => { calls.push({ ok, reason: failure?.reason, status: failure?.status }) } }
  await assert.rejects(observeResponse(new Response(new ReadableStream({ pull(c) { c.error(error) } })), { ...record }).text(), error)
  let cancelled = false
  const observed = observeResponse(new Response(new ReadableStream({ cancel() { cancelled = true } })), { ...record })
  await observed.body!.cancel()
  assert.equal(cancelled, true)
  const failed = new Response("nope", { status: 503 })
  assert.equal(observeResponse(failed, { ...record }), failed, "HTTP failures pass through untouched")
  assert.deepEqual(calls, [
    { ok: false, reason: "ordinary-stream-error", status: undefined },
    { ok: false, reason: "ordinary-stream-cancelled", status: undefined },
    { ok: false, reason: "ordinary-http-error", status: 503 },
  ])
})

test("hooked requests are read from a clone and decoded from zstd/gzip without consuming the original", async () => {
  const json = JSON.stringify({ model: "gpt-test", input: [] })
  for (const [encoding, body] of [[undefined, json], ["zstd", zstdCompressSync(json)], ["gzip", gzipSync(json)]] as const) {
    const request = new Request("https://chatgpt.com/backend-api/codex/responses", { method: "POST", body: body as BodyInit,
      headers: { authorization: "Bearer test-only", ...(encoding ? { "content-encoding": encoding } : {}) } })
    const read = await readRequest(request)
    assert.ok(!("reason" in read))
    assert.equal(read.init.body, json)
    assert.equal(new Headers(read.init.headers).get("content-encoding"), encoding ?? null)
    assert.equal(request.bodyUsed, false, "the host still owns the ordinary body")
  }
  const brotli = new Request("https://example.invalid", { method: "POST", body: "x", headers: { "content-encoding": "br" } })
  assert.deepEqual(await readRequest(brotli), { reason: "unsupported-content-encoding" })
  assert.deepEqual(await readRequest(new Request("https://example.invalid")), { reason: "unsupported-method" })
  const bomb = new Request("https://example.invalid", { method: "POST", body: zstdCompressSync(Buffer.alloc(MAX_BODY_BYTES + 10)),
    headers: { "content-encoding": "zstd" } })
  assert.deepEqual(await readRequest(bomb), { reason: "request-too-large" })
})

test("captures reach only live registrations and fail open; replays use the current global fetch", async () => {
  const http = transport()
  const throwing = () => { throw new Error("capture bug") }
  http.register("bad", throwing)
  assert.equal(http.capture("bad", "https://example.invalid", {}), undefined)
  let seen = 0
  http.register("good", () => { seen++; return {} })
  assert.ok(http.capture("good", "https://example.invalid", {}))
  http.remove("good")
  assert.equal(http.capture("good", "https://example.invalid", {}), undefined)
  assert.equal(seen, 1)
  const original = globalThis.fetch
  try {
    globalThis.fetch = (async () => new Response("late-bound")) as typeof fetch
    assert.equal(await (await http.fetch("https://example.invalid")).text(), "late-bound")
  } finally { globalThis.fetch = original }
})
