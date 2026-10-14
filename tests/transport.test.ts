import assert from "node:assert/strict"
import { test } from "node:test"
import { CAPTURE_HEADER } from "../protocol.ts"
import { observeResponse, transport } from "../transport.ts"

test("response observer preserves bytes, metadata, clone and completion ordering", async () => {
  const calls: boolean[] = []
  let pulls = 0
  const response = new Response(new ReadableStream({ pull(c) {
    pulls++
    if (pulls === 1) c.enqueue(new TextEncoder().encode("payload"))
    else c.close()
  } }, { highWaterMark: 0 }), { status: 200, statusText: "Original", headers: { "x-test": "yes" } })
  Object.defineProperty(response, "url", { value: "https://example.invalid/original" })
  Object.defineProperty(response, "redirected", { value: true })
  const signal = new AbortController()
  const observed = observeResponse(response, signal.signal, { complete: (ok) => { calls.push(ok) } })
  assert.equal(pulls, 0, "observer must not eagerly drain")
  assert.equal(observed instanceof Response, true)
  assert.equal(observed.url, response.url)
  assert.equal(observed.redirected, true)
  assert.equal(observed.type, response.type)
  assert.equal(observed.statusText, "Original")
  const clone = observed.clone()
  clone.headers.set("x-test", "clone-only")
  assert.equal(observed.headers.get("x-test"), "yes")
  assert.notEqual(clone.headers, observed.headers)
  assert.deepEqual(await Promise.all([observed.text(), clone.text()]), ["payload", "payload"])
  assert.equal(observed.bodyUsed, true)
  assert.deepEqual(calls, [true])
  signal.abort() // Successful OpenCode cleanup must not invalidate a completed capture.
  assert.deepEqual(calls, [true])
})

test("stream errors and cancellation report failure without changing the underlying error", async () => {
  const calls: boolean[] = []
  const error = new Error("provider stream failed")
  const response = observeResponse(new Response(new ReadableStream({ pull(c) { c.error(error) } })), undefined, { complete: (ok) => { calls.push(ok) } })
  await assert.rejects(response.text(), error)
  assert.deepEqual(calls, [false])
  let cancelled = false
  const observed = observeResponse(new Response(new ReadableStream({ cancel() { cancelled = true } })), undefined, { complete: (ok) => { calls.push(ok) } })
  await observed.body!.cancel()
  assert.equal(cancelled, true)
  assert.deepEqual(calls, [false, false])
})

test("abort and body cancellation report their reason once despite late body completion", async () => {
  for (const abort of [true, false]) {
    const calls: unknown[] = []
    const controller = new AbortController()
    const observed = observeResponse(new Response("payload"), controller.signal, {
      complete: (ok, failure) => calls.push({ ok, reason: failure?.reason }),
    })
    if (abort) {
      controller.abort()
      assert.equal(await observed.text(), "payload")
    } else await observed.body!.cancel()
    assert.deepEqual(calls, [{ ok: false, reason: abort ? "ordinary-aborted" : "ordinary-stream-cancelled" }])
  }
})

test("one shared interceptor scrubs late markers and keeps unmarked traffic untouched", async () => {
  const seen: [RequestInfo | URL, RequestInit | undefined][] = []
  const failure = new Error("fixture fetch failure")
  globalThis.fetch = (async (input, init) => {
    seen.push([input, init])
    if (String(input).endsWith("/failure")) throw failure
    return new Response("ok")
  }) as typeof fetch
  const http = transport()
  assert.equal(transport(), http)
  const normal = { method: "POST", body: "unchanged", headers: { "x-normal": "yes" } }
  await globalThis.fetch("https://example.invalid", normal)
  assert.equal(seen[0][1], normal)
  let completed = false
  http.register("capture", (_url, init) => {
    assert.equal(new Headers(init.headers).has(CAPTURE_HEADER), false)
    return { complete: () => { completed = true } }
  })
  const signal = new AbortController().signal
  const init = { ...normal, signal, headers: { ...normal.headers, [CAPTURE_HEADER]: "capture" } }
  const response = await globalThis.fetch("https://example.invalid", init)
  assert.equal(completed, false)
  assert.equal(seen[1][1]?.signal, signal)
  assert.equal(seen[1][1]?.body, "unchanged")
  await response.text()
  assert.equal(completed, true)
  http.remove("capture")
  await globalThis.fetch("https://example.invalid", init)
  assert.equal(new Headers(seen[2][1]?.headers).has(CAPTURE_HEADER), false)
  assert.equal(init.headers[CAPTURE_HEADER], "capture")
  await http.fetch("https://example.invalid", { ...normal })
  assert.equal(seen.length, 4, "unwrapped warm transport does not recurse")
  for (const aborted of [true, false]) {
    const controller = new AbortController()
    if (aborted) controller.abort()
    const calls: unknown[] = []
    http.register("fetch-failure", () => ({ complete: (ok, details) => calls.push({ ok, reason: details?.reason }) }))
    await assert.rejects(globalThis.fetch("https://example.invalid/failure", {
      signal: controller.signal, headers: { [CAPTURE_HEADER]: "fetch-failure" },
    }), failure)
    assert.deepEqual(calls, [{ ok: false, reason: aborted ? "ordinary-aborted" : "ordinary-fetch-error" }])
    http.remove("fetch-failure")
  }
})
