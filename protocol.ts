import { Buffer } from "node:buffer"

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

function inputItem(value: unknown): boolean {
  if (!object(value)) return false
  if (value.type === "function_call") {
    return [value.call_id, value.name, value.arguments].every((field) => typeof field === "string")
  }
  if (value.type === "function_call_output") {
    return typeof value.call_id === "string" && textContent(value.output)
  }
  if (value.type === "reasoning") {
    return Array.isArray(value.summary) && value.summary.every((part) =>
      object(part) && part.type === "summary_text" && typeof part.text === "string") &&
      (value.encrypted_content === undefined || typeof value.encrypted_content === "string")
  }
  return (value.type === undefined || value.type === "message") &&
    ["system", "developer", "user", "assistant"].includes(String(value.role)) && textContent(value.content)
}

/** Deliberately narrow: an OAuth HTTP Codex request, not a generic Responses adapter. */
export function captureRequest(url: string, init: RequestInit): Snapshot | undefined {
  if (url !== CODEX_ENDPOINT || init.method?.toUpperCase() !== "POST" ||
      typeof init.body !== "string" || init.body.length > MAX_BODY_BYTES ||
      Buffer.byteLength(init.body, "utf8") > MAX_BODY_BYTES) return
  try {
    const headers = new Headers(init.headers)
    if (!headers.get("authorization")?.startsWith("Bearer ") ||
        !headers.get("content-type")?.includes("application/json")) return
    const body: unknown = JSON.parse(init.body)
    if (!object(body) || typeof body.model !== "string" || body.stream !== true ||
        !Array.isArray(body.input) || !body.input.every(inputItem)) return
    if (["previous_response_id", "conversation", "prompt", "audio"].some((key) => key in body) ||
        (body.background !== undefined && body.background !== false) ||
        (body.modalities !== undefined &&
          (!Array.isArray(body.modalities) || body.modalities.some((value) => value !== "text"))) ||
        (object(body.prompt_cache_options) && body.prompt_cache_options.prewarm === true)) return
    if (body.tools !== undefined && (!Array.isArray(body.tools) || !body.tools.every((tool) =>
      object(tool) && tool.type === "function" && typeof tool.name === "string" && object(tool.parameters)))) return
    headers.delete(CAPTURE_HEADER)
    headers.delete("content-length")
    headers.delete("transfer-encoding")
    headers.delete("connection")
    headers.delete("idempotency-key")
    return { url, headers, body }
  } catch {
    return
  }
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

/** Bounded metadata parser. No response text is retained or returned. */
export async function discardWarmResponse(response: Response, signal: AbortSignal): Promise<Usage | undefined> {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    await response.body?.cancel()
    throw new Error("unsupported-warm-response")
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  let bytes = 0
  let completed = false
  let failed = false
  let usage: Usage | undefined
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener("abort", abort, { once: true })
  function frame(text: string) {
    const data = text.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n")
    if (!data || data === "[DONE]") return
    const event: unknown = JSON.parse(data)
    if (!object(event)) return
    if (["error", "response.failed", "response.incomplete"].includes(String(event.type))) failed = true
    if (event.type !== "response.completed") return
    completed = true
    if (!object(event.response) || !object(event.response.usage)) return
    const value = event.response.usage
    usage = {
      inputTokens: finiteToken(value.input_tokens),
      cachedTokens: object(value.input_tokens_details) ? finiteToken(value.input_tokens_details.cached_tokens) : undefined,
      outputTokens: finiteToken(value.output_tokens),
    }
  }
  try {
    signal.throwIfAborted()
    while (true) {
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("warm-response-too-large")
      pending += decoder.decode(chunk.value, { stream: true })
      let match: RegExpExecArray | null
      while ((match = /\r?\n\r?\n/.exec(pending))) {
        const text = pending.slice(0, match.index)
        if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) throw new Error("warm-frame-too-large")
        pending = pending.slice(match.index + match[0].length)
        frame(text)
      }
      if (Buffer.byteLength(pending, "utf8") > MAX_FRAME_BYTES) throw new Error("warm-frame-too-large")
    }
    pending += decoder.decode()
    if (pending.trim()) frame(pending)
    if (!completed || failed) throw new Error("warm-response-not-completed")
    return usage
  } finally {
    signal.removeEventListener("abort", abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function retryAfterMs(value: string | null, now: number): number {
  if (!value) return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : 0
}
