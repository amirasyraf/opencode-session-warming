import { Buffer } from "node:buffer"
import { errorDetails } from "./diagnostics.ts"
import { MAX_BODY_BYTES } from "./protocol.ts"

type Failure = { reason?: string; status?: number; errorCategory?: string; errorCode?: string }
type Complete = (ok: boolean, failure?: Failure) => void
export type Observation = { complete?: Complete }
export type Capture = (url: string, init: RequestInit) => Observation | undefined
/**
 * OpenCode V2 exposes ordinary provider traffic through `session.hook("http.request" | "http.response")`.
 * There is no process-wide fetch shim: the plugin only observes requests the host hands to its hooks, and
 * warm replays are independent calls through the runtime's current `fetch`.
 */
export type Transport = {
  fetch: typeof fetch
  register: (token: string, capture: Capture) => void
  remove: (token: string) => void
  /** Offer a decoded ordinary request to a live registration. Never throws. */
  capture: (token: string, url: string, init: RequestInit) => Observation | undefined
}

export function complete(observation: Observation, ok: boolean, failure?: Failure) {
  const callback = observation.complete
  observation.complete = undefined
  try { callback?.(ok, failure) } catch { /* Plugin observation never fails ordinary traffic. */ }
}

/** Wrap only the body stream so ordinary consumers keep pull-based backpressure and cancellation. */
export function observeResponse(response: Response, observation: Observation): Response {
  if (!response.ok) { complete(observation, false, { reason: "ordinary-http-error", status: response.status }); return response }
  if (!response.body) { complete(observation, true); return response }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let finished = false
  const finish = (ok: boolean, failure?: Failure) => {
    if (finished) return
    finished = true
    complete(observation, ok, failure)
  }
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        reader ??= response.body!.getReader()
        const chunk = await reader.read()
        if (chunk.done) {
          finish(true)
          reader.releaseLock()
          controller.close()
        } else controller.enqueue(chunk.value)
      } catch (error) {
        finish(false, { reason: "ordinary-stream-error", ...errorDetails(error) })
        reader?.releaseLock()
        controller.error(error)
      }
    },
    async cancel(reason) {
      finish(false, { reason: "ordinary-stream-cancelled" })
      if (reader) {
        try { await reader.cancel(reason) } finally { reader.releaseLock() }
      } else await response.body!.cancel(reason)
    },
  }, { highWaterMark: 0 })
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers })
}

/**
 * Read a bounded copy of a hooked request body and decode the content encodings OpenCode applies
 * (`zstd` for ChatGPT, optionally `gzip`). The ordinary request object is cloned, never consumed.
 */
export async function readRequest(request: Request): Promise<{ url: string; init: RequestInit } | { reason: string }> {
  if (request.method.toUpperCase() !== "POST") return { reason: "unsupported-method" }
  const declared = Number(request.headers.get("content-length") ?? 0)
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { reason: "request-too-large" }
  const raw = new Uint8Array(await request.clone().arrayBuffer())
  if (raw.byteLength > MAX_BODY_BYTES) return { reason: "request-too-large" }
  const encoding = request.headers.get("content-encoding")?.trim().toLowerCase() || undefined
  let decoded: Uint8Array
  if (encoding === undefined) decoded = raw
  else {
    const zlib = globalThis.process?.getBuiltinModule?.("node:zlib") as typeof import("node:zlib") | undefined
    const limit = { maxOutputLength: MAX_BODY_BYTES + 1 }
    try {
      if (encoding === "zstd" && zlib?.zstdDecompressSync) decoded = zlib.zstdDecompressSync(raw, limit)
      else if (encoding === "gzip" && zlib) decoded = zlib.gunzipSync(raw, limit)
      else return { reason: "unsupported-content-encoding" }
    } catch (error) {
      return { reason: (error as { code?: string })?.code === "ERR_BUFFER_TOO_LARGE" ? "request-too-large" : "unsupported-content-encoding" }
    }
    if (decoded.byteLength > MAX_BODY_BYTES) return { reason: "request-too-large" }
  }
  return { url: request.url, init: { method: "POST", headers: new Headers(request.headers), body: Buffer.from(decoded).toString("utf8") } }
}

export function transport(): Transport {
  const registrations = new Map<string, Capture>()
  return {
    // Late-bound so test fixtures and host network policy apply to replays exactly as to ordinary traffic.
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init)) as typeof fetch,
    register: (token, capture) => { registrations.set(token, capture) },
    remove: (token) => { registrations.delete(token) },
    capture: (token, url, init) => {
      try { return registrations.get(token)?.(url, init) } catch { return undefined }
    },
  }
}
