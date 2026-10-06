import { Buffer } from "node:buffer"
import { WarmingFailure } from "./diagnostics.ts"

export const CAPTURE_HEADER = "x-opencode-session-warming"
export const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
export const KEEPALIVE = "Do not perform any work. Do not use tools. Reply with exactly: OK"
const MAX_BODY_BYTES = 16 * 1024 * 1024
const MAX_FRAME_BYTES = 1024 * 1024
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

type ObjectValue = Record<string, unknown>
export type Snapshot = { url: string; headers: Headers; body: ObjectValue }
export type Usage = { inputTokens?: number; cachedTokens?: number; outputTokens?: number }

export function object(value: unknown): value is ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function textContent(value: unknown): boolean {
  return typeof value === "string" || (Array.isArray(value) && value.every((part) =>
    object(part) && (
      ((part.type === "input_text" || part.type === "output_text") && typeof part.text === "string") ||
      (part.type === "refusal" && typeof part.refusal === "string")
    )))
}

function inputItemReason(value: unknown): string | undefined {
  if (!object(value)) return "unsupported-input-item"
  if (value.type === "function_call") {
    return [value.call_id, value.name, value.arguments].every((field) => typeof field === "string") ? undefined : "unsupported-input-function-call"
  }
  if (value.type === "function_call_output") {
    return typeof value.call_id === "string" && textContent(value.output) ? undefined : "unsupported-input-function-result"
  }
  if (value.type === "reasoning") {
    const summary = value.summary
    const summaryOK = summary === undefined || summary === null || (Array.isArray(summary) && summary.every((part) =>
      object(part) && part.type === "summary_text" && typeof part.text === "string"))
    return summaryOK && (value.encrypted_content === undefined || typeof value.encrypted_content === "string")
      ? undefined : "unsupported-input-reasoning"
  }
  return (value.type === undefined || value.type === "message") &&
    ["system", "developer", "user", "assistant"].includes(String(value.role)) && textContent(value.content)
    ? undefined : `unsupported-input-${typeof value.type === "string" ? value.type.replace(/[^a-z0-9-]/gi, "-").toLowerCase().slice(0, 32) : "message"}`
}

/** Deliberately narrow: an OAuth HTTP Codex request, not a generic Responses adapter. */
export function classifyRequest(url: string, init: RequestInit): { snapshot: Snapshot; reason?: never } | { snapshot?: never; reason: string } {
  if (url !== CODEX_ENDPOINT) return { reason: "unsupported-endpoint" }
  if (init.method?.toUpperCase() !== "POST") return { reason: "unsupported-method" }
  if (typeof init.body !== "string") return { reason: "unsupported-body-type" }
  if (init.body.length > MAX_BODY_BYTES || Buffer.byteLength(init.body, "utf8") > MAX_BODY_BYTES) return { reason: "request-too-large" }
  try {
    const headers = new Headers(init.headers)
    if (!headers.get("authorization")?.startsWith("Bearer ")) return { reason: "missing-bearer-auth" }
    if (!headers.get("content-type")?.includes("application/json")) return { reason: "unsupported-content-type" }
    const body: unknown = JSON.parse(init.body)
    if (!object(body) || typeof body.model !== "string") return { reason: "unsupported-model" }
    if (body.stream !== true) return { reason: "non-streaming-request" }
    if (!Array.isArray(body.input)) return { reason: "unsupported-input" }
    const inputReason = body.input.map(inputItemReason).find((reason) => reason !== undefined)
    if (inputReason) return { reason: inputReason }
    if (["previous_response_id", "conversation", "prompt"].some((key) => key in body)) return { reason: "stateful-request" }
    if (body.background !== undefined && body.background !== false) return { reason: "server-background" }
    if ("audio" in body || (body.modalities !== undefined &&
      (!Array.isArray(body.modalities) || body.modalities.some((value) => value !== "text")))) return { reason: "unsupported-modality" }
    if (object(body.prompt_cache_options) && body.prompt_cache_options.prewarm === true) return { reason: "provider-prewarm" }
    if (body.tools !== undefined && (!Array.isArray(body.tools) || !body.tools.every((tool) =>
      object(tool) && tool.type === "function" && typeof tool.name === "string" && object(tool.parameters)))) return { reason: "unsupported-tools" }
    headers.delete(CAPTURE_HEADER)
    headers.delete("content-length")
    headers.delete("transfer-encoding")
    headers.delete("connection")
    headers.delete("idempotency-key")
    return { snapshot: { url, headers, body } }
  } catch {
    return { reason: "invalid-json-or-headers" }
  }
}

export function captureRequest(url: string, init: RequestInit): Snapshot | undefined {
  return classifyRequest(url, init).snapshot
}

export function warmRequest(snapshot: Snapshot, signal: AbortSignal): RequestInit {
  return {
    method: "POST",
    headers: new Headers(snapshot.headers),
    body: JSON.stringify({
      ...snapshot.body,
      input: [...snapshot.body.input as unknown[], { role: "user", content: [{ type: "input_text", text: KEEPALIVE }] }],
      tool_choice: "none",
      store: false,
    }),
    signal,
    redirect: "error",
  }
}

function finiteToken(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function extractUsage(value: unknown): Usage | undefined {
  if (!object(value) || !object(value.usage)) return
  return {
    inputTokens: finiteToken(value.usage.input_tokens),
    cachedTokens: object(value.usage.input_tokens_details) ? finiteToken(value.usage.input_tokens_details.cached_tokens) : undefined,
    outputTokens: finiteToken(value.usage.output_tokens),
  }
}

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw new WarmingFailure("warm-response-too-large")
      text += decoder.decode(chunk.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Bounded metadata parser. No response text is retained or returned. */
export async function discardWarmResponse(response: Response, signal: AbortSignal): Promise<Usage | undefined> {
  if (!response.body) return
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    signal.throwIfAborted()
    const body = await readBoundedBody(response)
    if (!body.trim()) return
    try { return extractUsage(JSON.parse(body)) }
    catch { throw new WarmingFailure("invalid-warm-json") }
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  let bytes = 0
  let completed = false
  let failed: string | undefined
  let usage: Usage | undefined
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener("abort", abort, { once: true })
  function frame(text: string) {
    const data = text.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n")
    if (!data || data === "[DONE]") return
    let event: unknown
    try { event = JSON.parse(data) } catch { throw new WarmingFailure("invalid-sse-json") }
    if (!object(event)) return
    if (event.type === "error" || event.type === "response.failed") failed = "stream-failed"
    if (event.type === "response.incomplete") failed = "stream-incomplete"
    if (event.type !== "response.completed") return
    completed = true
    usage = usageFromResponse(event.response)
  }
  try {
    signal.throwIfAborted()
    while (true) {
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw new WarmingFailure("warm-response-too-large")
      pending += decoder.decode(chunk.value, { stream: true })
      let match: RegExpExecArray | null
      while ((match = /\r?\n\r?\n/.exec(pending))) {
        const text = pending.slice(0, match.index)
        if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) throw new WarmingFailure("warm-frame-too-large")
        pending = pending.slice(match.index + match[0].length)
        frame(text)
      }
      if (Buffer.byteLength(pending, "utf8") > MAX_FRAME_BYTES) throw new WarmingFailure("warm-frame-too-large")
    }
    pending += decoder.decode()
    if (pending.trim()) frame(pending)
    if (failed) throw new WarmingFailure(failed)
    if (!completed) throw new WarmingFailure("stream-truncated")
    return usage
  } finally {
    signal.removeEventListener("abort", abort)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function usageFromResponse(value: unknown): Usage | undefined {
  if (!object(value)) return
  return extractUsage(value)
}

export function retryAfterMs(value: string | null, now: number): number {
  if (!value) return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : 0
}
