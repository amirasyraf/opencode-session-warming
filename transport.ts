import { CAPTURE_HEADER } from "./protocol.ts"

type Complete = (ok: boolean) => void
export type Observation = { complete?: Complete }
export type Capture = (url: string, init: RequestInit) => Observation | undefined
export type Transport = {
  fetch: typeof fetch
  register: (token: string, capture: Capture) => void
  remove: (token: string) => void
}
const KEY = Symbol.for("opencode-session-warming.transport.v1")

/** Replace only body-consumption methods; preserve the original response's metadata. */
function responseView(original: Response, bodyResponse: Response, headers = original.headers): Response {
  const bodyMethods = new Set(["arrayBuffer", "blob", "bytes", "formData", "json", "text"])
  return new Proxy(original, {
    get(target, property) {
      if (property === "body" || property === "bodyUsed") return Reflect.get(bodyResponse, property, bodyResponse)
      if (property === "headers") return headers
      if (property === "clone") return () => {
        const clone = bodyResponse.clone()
        for (const key of [...clone.headers.keys()]) clone.headers.delete(key)
        for (const [key, value] of headers) clone.headers.set(key, value)
        return responseView(original, clone, clone.headers)
      }
      const source = bodyMethods.has(String(property)) ? bodyResponse : target
      const value: unknown = Reflect.get(source, property, source)
      return typeof value === "function" ? value.bind(source) : value
    },
  })
}

function complete(observation: Observation, ok: boolean) {
  const callback = observation.complete
  observation.complete = undefined
  try { callback?.(ok) } catch { /* Plugin observation never fails ordinary traffic. */ }
}

export function observeResponse(response: Response, signal: AbortSignal | null | undefined, observation: Observation): Response {
  if (!response.body) { complete(observation, response.ok); return response }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let finished = false
  const finish = (ok: boolean) => {
    if (finished) return
    finished = true
    signal?.removeEventListener("abort", aborted)
    complete(observation, ok)
  }
  const aborted = () => finish(false)
  signal?.addEventListener("abort", aborted, { once: true })
  if (signal?.aborted) finish(false)
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        reader ??= response.body!.getReader()
        const chunk = await reader.read()
        if (chunk.done) {
          finish(response.ok)
          reader.releaseLock()
          controller.close()
        } else controller.enqueue(chunk.value)
      } catch (error) {
        finish(false)
        reader?.releaseLock()
        controller.error(error)
      }
    },
    async cancel(reason) {
      finish(false)
      if (reader) {
        try { await reader.cancel(reason) } finally { reader.releaseLock() }
      } else await response.body!.cancel(reason)
    },
  }, { highWaterMark: 0 })
  return responseView(response, new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  }))
}

/** Exactly one shared, process-lifetime shim. Disposed instances remove their registrations. */
export function transport(): Transport {
  const globals = globalThis as typeof globalThis & { [KEY]?: Transport }
  if (globals[KEY]) return globals[KEY]
  const original = globalThis.fetch
  const registrations = new Map<string, Capture>()
  const wrapper = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const token = headers.get(CAPTURE_HEADER)
    if (!token) return original(input, init)
    headers.delete(CAPTURE_HEADER)
    // Preserve all ordinary fetch options; only our reserved header is removed.
    const clean = { ...init, headers }
    const url = input instanceof Request ? input.url : String(input)
    let observation: Observation | undefined
    try { observation = registrations.get(token)?.(url, clean) } catch { /* Fail open for ordinary traffic. */ }
    try {
      const response = await original(input, clean)
      if (!observation) return response
      if (!response.ok) { complete(observation, false); return response }
      return observeResponse(response, clean.signal ?? (input instanceof Request ? input.signal : undefined), observation)
    } catch (error) {
      if (observation) complete(observation, false)
      throw error
    }
  }) as typeof fetch
  // Bun's fetch exposes runtime helpers (e.g. preconnect); preserve them.
  for (const key of Reflect.ownKeys(original)) {
    if (!["name", "length", "prototype"].includes(String(key))) {
      try { Object.defineProperty(wrapper, key, Object.getOwnPropertyDescriptor(original, key)!) } catch { /* Optional helper. */ }
    }
  }
  const result: Transport = {
    fetch: original,
    register: (token, capture) => { registrations.set(token, capture) },
    remove: (token) => { registrations.delete(token) },
  }
  globals[KEY] = result
  globalThis.fetch = wrapper
  return result
}
