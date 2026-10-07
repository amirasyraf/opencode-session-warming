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
export type Usage = { inputTokens?: number; cachedTokens?: number; outputTokens?: number; cacheWriteTokens?: number;
  cacheWrite5mTokens?: number; cacheWrite1hTokens?: number; outputLimitReached?: boolean }
export type ResponseContract = { protocol?: "responses" | "messages"; strict?: boolean; outputLimited?: boolean }

export function object(value: unknown): value is ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function embeddedImage(part: ObjectValue): boolean {
  if ("file_id" in part || typeof part.image_url !== "string") return false
  if (part.detail !== undefined && part.detail !== null &&
    (typeof part.detail !== "string" || !["auto", "low", "high", "original"].includes(part.detail))) return false
  const prefix = /^data:image\/(?:png|jpeg|webp|gif);base64,/i.exec(part.image_url)
  if (!prefix) return false
  const data = part.image_url.slice(prefix[0].length)
  return data.length > 0 && data.length % 4 === 0 && /^[a-z0-9+/]+={0,2}$/i.test(data)
}

function contentReason(value: unknown, fallback: string, images = false): string | undefined {
  if (typeof value === "string") return
  if (!Array.isArray(value)) return fallback
  for (const part of value) {
    if (!object(part)) return fallback
    if ((part.type === "input_text" || part.type === "output_text") && typeof part.text === "string") continue
    if (part.type === "refusal" && typeof part.refusal === "string") continue
    if (part.type === "input_image") {
      if (images && embeddedImage(part)) continue
      return "unsupported-input-image"
    }
    if (part.type === "input_file") return "unsupported-input-file"
    if (part.type === "input_audio") return "unsupported-input-audio"
    return fallback
  }
}

function inputItemReason(value: unknown): string | undefined {
  if (!object(value)) return "unsupported-input-item"
  if (value.type === "function_call") {
    return [value.call_id, value.name, value.arguments].every((field) => typeof field === "string") ? undefined : "unsupported-input-function-call"
  }
  if (value.type === "function_call_output") {
    return typeof value.call_id === "string"
      ? contentReason(value.output, "unsupported-input-function-result", true) : "unsupported-input-function-result"
  }
  if (value.type === "reasoning") {
    const summary = value.summary
    const summaryOK = summary === undefined || summary === null || (Array.isArray(summary) && summary.every((part) =>
      object(part) && part.type === "summary_text" && typeof part.text === "string"))
    return summaryOK && (value.encrypted_content === undefined || typeof value.encrypted_content === "string")
      ? undefined : "unsupported-input-reasoning"
  }
  if (value.type === "configuration_update") {
    return object(value.reasoning) && typeof value.reasoning.effort === "string" &&
      Object.keys(value).every((key) => ["type", "reasoning"].includes(key)) &&
      Object.keys(value.reasoning).every((key) => key === "effort") ? undefined : "unsupported-configuration-update"
  }
  if ((value.type === undefined || value.type === "message") &&
    ["system", "developer", "user", "assistant"].includes(String(value.role))) {
    return contentReason(value.content, "unsupported-input-message", value.role === "user")
  }
  return `unsupported-input-${typeof value.type === "string" ? value.type.replace(/[^a-z0-9-]/gi, "-").toLowerCase().slice(0, 32) : "message"}`
}

function cacheControl(value: unknown): boolean {
  return object(value) && value.type === "ephemeral" && (value.ttl === undefined || ["5m", "1h"].includes(String(value.ttl))) &&
    Object.keys(value).every((key) => ["type", "ttl"].includes(key))
}

function messageContent(value: unknown, role: unknown, nested = false): string | undefined {
  if (typeof value === "string") return
  if (!Array.isArray(value)) return "unsupported-input-message"
  for (const part of value) {
    if (!object(part)) return "unsupported-input-message"
    if (part.cache_control !== undefined && (nested || !cacheControl(part.cache_control))) return "unsupported-cache-control"
    if (part.type === "text" && typeof part.text === "string" && part.citations === undefined) continue
    if (part.type === "image") {
      const source = part.source
      if (role === "user" && object(source) && source.type === "base64" && typeof source.media_type === "string" &&
        typeof source.data === "string" && embeddedImage({ image_url: `data:${source.media_type};base64,${source.data}` })) continue
      return "unsupported-input-image"
    }
    if (part.type === "document") return "unsupported-input-file"
    if (part.type === "audio") return "unsupported-input-audio"
    if (part.type === "tool_use" && role === "assistant" && !nested && typeof part.id === "string" &&
      typeof part.name === "string" && object(part.input)) continue
    if (part.type === "tool_result" && role === "user" && !nested && typeof part.tool_use_id === "string") {
      if (part.is_error !== undefined && typeof part.is_error !== "boolean") return "unsupported-input-function-result"
      const reason = messageContent(part.content, role, true)
      if (reason) return reason
      continue
    }
    if (!nested && role === "assistant" && part.cache_control === undefined &&
      ((part.type === "thinking" && typeof part.thinking === "string" && typeof part.signature === "string") ||
        (part.type === "redacted_thinking" && typeof part.data === "string"))) continue
    return "unsupported-input-item"
  }
}

const responsesFields = new Set(["model", "input", "instructions", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "text",
  "stream", "store", "max_output_tokens", "temperature", "top_p", "metadata", "service_tier", "safety_identifier", "user",
  "prompt_cache_key", "prompt_cache_retention", "prompt_cache_options", "include", "truncation", "background", "stream_options"])
const messagesFields = new Set(["model", "messages", "system", "tools", "tool_choice", "thinking", "output_config", "max_tokens",
  "stream", "temperature", "top_p", "top_k", "stop_sequences", "metadata", "service_tier", "cache_control"])

/** Endpoints are supplied only by registered adapters; ordinary request data is never mutated. */
export function classifyRequest(url: string, init: RequestInit, contract: { endpoint?: string; protocol?: "responses" | "messages"; strict?: boolean } = {}):
  { snapshot: Snapshot; reason?: never } | { snapshot?: never; reason: string } {
  if (url !== (contract.endpoint ?? CODEX_ENDPOINT)) return { reason: "unsupported-endpoint" }
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
    if (["previous_response_id", "conversation", "prompt"].some((key) => key in body)) return { reason: "stateful-request" }
    if (body.background !== undefined && body.background !== false) return { reason: "server-background" }
    if ("audio" in body || (body.modalities !== undefined &&
      (!Array.isArray(body.modalities) || body.modalities.some((value) => value !== "text")))) return { reason: "unsupported-modality" }
    if (object(body.prompt_cache_options) && body.prompt_cache_options.prewarm === true) return { reason: "provider-prewarm" }
    if (contract.protocol === "messages") {
      if (!Array.isArray(body.messages) || !body.messages.length) return { reason: "unsupported-input" }
      for (const message of body.messages) {
        if (!object(message) || !["user", "assistant"].includes(String(message.role)) ||
          Object.keys(message).some((key) => !["role", "content"].includes(key))) return { reason: "unsupported-input-message" }
        const reason = messageContent(message.content, message.role)
        if (reason) return { reason }
      }
      if (body.system !== undefined) {
        if (Array.isArray(body.system) && body.system.some((part) => !object(part) || part.type !== "text")) return { reason: "unsupported-system" }
        const reason = messageContent(body.system, "system")
        if (reason) return { reason }
      }
      if (!Number.isSafeInteger(body.max_tokens) || Number(body.max_tokens) <= 0) return { reason: "unsupported-output-limit" }
      if (body.thinking !== undefined && (!object(body.thinking) || !["adaptive", "disabled"].includes(String(body.thinking.type)) ||
        "budget_tokens" in body.thinking)) return { reason: "unsupported-thinking-budget" }
      if (body.cache_control !== undefined && !cacheControl(body.cache_control)) return { reason: "unsupported-cache-control" }
      if (body.tools !== undefined && (!Array.isArray(body.tools) || !body.tools.every((tool) => object(tool) &&
        (tool.type === undefined || tool.type === "custom") && typeof tool.name === "string" && object(tool.input_schema) &&
        Object.keys(tool).every((key) => ["type", "name", "description", "input_schema", "cache_control"].includes(key)) &&
        (tool.cache_control === undefined || cacheControl(tool.cache_control))))) return { reason: "unsupported-tools" }
    } else {
      if (!Array.isArray(body.input)) return { reason: "unsupported-input" }
      const inputReason = body.input.map(inputItemReason).find((reason) => reason !== undefined)
      if (inputReason) return { reason: inputReason }
      if (body.tools !== undefined && (!Array.isArray(body.tools) || !body.tools.every((tool) =>
        object(tool) && tool.type === "function" && typeof tool.name === "string" && object(tool.parameters) &&
        (!contract.strict || Object.keys(tool).every((key) => ["type", "name", "description", "parameters", "strict"].includes(key)))))) return { reason: "unsupported-tools" }
      if (contract.strict && body.max_output_tokens !== undefined && (!Number.isSafeInteger(body.max_output_tokens) || Number(body.max_output_tokens) <= 0)) return { reason: "unsupported-output-limit" }
      if (contract.strict && body.prompt_cache_options !== undefined && (!object(body.prompt_cache_options) ||
        Object.keys(body.prompt_cache_options).some((key) => !["mode", "ttl", "prewarm"].includes(key)) ||
        (body.prompt_cache_options.mode !== undefined && !["implicit", "explicit"].includes(String(body.prompt_cache_options.mode))) ||
        (body.prompt_cache_options.ttl !== undefined && body.prompt_cache_options.ttl !== "30m") ||
        (body.prompt_cache_options.prewarm !== undefined && body.prompt_cache_options.prewarm !== false))) return { reason: "unsupported-cache-control" }
      if (contract.strict && object(body.prompt_cache_options) && body.prompt_cache_options.mode === "explicit" &&
        !body.input.some((item) => object(item) && Array.isArray(item.content) && item.content.some((part) =>
          object(part) && object(part.prompt_cache_breakpoint) && part.prompt_cache_breakpoint.mode === "explicit"))) return { reason: "cache-disabled" }
    }
    if (contract.strict && Object.keys(body).some((key) => !(contract.protocol === "messages" ? messagesFields : responsesFields).has(key))) return { reason: "unsupported-request-field" }
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
  const usage: Usage = {
    inputTokens: finiteToken(value.usage.input_tokens),
    cachedTokens: object(value.usage.input_tokens_details) ? finiteToken(value.usage.input_tokens_details.cached_tokens) : undefined,
    outputTokens: finiteToken(value.usage.output_tokens),
  }
  const writes = object(value.usage.input_tokens_details) ? finiteToken(value.usage.input_tokens_details.cache_write_tokens) : undefined
  if (writes !== undefined) usage.cacheWriteTokens = writes
  return usage
}

function messagesUsage(value: unknown): Usage | undefined {
  if (!object(value)) return
  const cachedTokens = finiteToken(value.cache_read_input_tokens)
  const cacheWriteTokens = finiteToken(value.cache_creation_input_tokens)
  const uncached = finiteToken(value.input_tokens)
  const usage: Usage = { inputTokens: uncached !== undefined && cachedTokens !== undefined && cacheWriteTokens !== undefined ?
    uncached + cachedTokens + cacheWriteTokens : undefined, cachedTokens, cacheWriteTokens, outputTokens: finiteToken(value.output_tokens) }
  if (object(value.cache_creation)) {
    usage.cacheWrite5mTokens = finiteToken(value.cache_creation.ephemeral_5m_input_tokens)
    usage.cacheWrite1hTokens = finiteToken(value.cache_creation.ephemeral_1h_input_tokens)
  }
  return usage
}

/** Bounded metadata parser. No response text is retained or returned. */
export async function discardWarmResponse(response: Response, signal: AbortSignal, contract: ResponseContract = {}): Promise<Usage | undefined> {
  if (!response.body) { if (contract.strict) throw new WarmingFailure("unsupported-warm-response"); return }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  let format: "sse" | "json" | undefined = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ? "sse" : undefined
  let bytes = 0
  let completed = false
  let failed: string | undefined
  let usage: Usage | undefined
  let messageStarted = false
  let messageStopped = false
  const messageTerminal = (value: unknown) => {
    if (!object(value)) return false
    if (["end_turn", "stop_sequence", "tool_use"].includes(String(value.stop_reason))) return true
    if (contract.outputLimited && value.stop_reason === "max_tokens") {
      usage = { ...usage, outputLimitReached: true }; return true
    }
    return false
  }
  const responseTerminal = (value: unknown) => {
    if (!contract.strict) return true
    if (!object(value) || value.object !== "response" || value.error) return false
    if (value.status === "completed") return true
    if (contract.outputLimited && value.status === "incomplete" && object(value.incomplete_details) && value.incomplete_details.reason === "max_output_tokens") {
      usage = { ...usage, outputLimitReached: true }; return true
    }
    return false
  }
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener("abort", abort, { once: true })
  function frame(text: string) {
    const data = text.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n")
    if (!data || data === "[DONE]") return
    let event: unknown
    try { event = JSON.parse(data) } catch { throw new WarmingFailure("invalid-sse-json") }
    if (!object(event)) return
    if (event.type === "error" || event.type === "response.failed" || event.error) failed = "stream-failed"
    if (contract.protocol === "messages") {
      if (event.type === "message_start" && object(event.message) && event.message.type === "message") {
        messageStarted = true; usage = messagesUsage(event.message.usage)
      }
      if (event.type === "message_delta" && messageStarted) {
        if (object(event.usage)) usage = { ...usage, ...Object.fromEntries(Object.entries(messagesUsage(event.usage) ?? {}).filter(([, value]) => value !== undefined)) }
        messageStopped = messageTerminal(event.delta)
      }
      if (event.type === "message_stop" && messageStarted && messageStopped) completed = true
      return
    }
    if (event.type === "response.incomplete") {
      usage = usageFromResponse(event.response)
      if (responseTerminal(event.response) && contract.outputLimited) completed = true
      else failed = "stream-incomplete"
    }
    if (event.type !== "response.completed") return
    usage = usageFromResponse(event.response)
    completed = responseTerminal(event.response)
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
      if (!format) {
        // Some Codex HTTP responses omit/mislabel the SSE media type. Wait for
        // a full field prefix so detection also works across arbitrary chunks.
        const prefix = pending.trimStart()
        if (/^(?:data:|event:|id:|retry:|:)/.test(prefix)) format = "sse"
        else if (prefix && !["data:", "event:", "id:", "retry:"].some((field) => field.startsWith(prefix))) format = "json"
      }
      if (format !== "sse") continue
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
    if (format !== "sse") {
      if (!pending.trim()) { if (contract.strict) throw new WarmingFailure("unsupported-warm-response"); return }
      let value: unknown
      try { value = JSON.parse(pending) } catch { throw new WarmingFailure("invalid-warm-json") }
      if (object(value) && value.error) throw new WarmingFailure("stream-failed")
      usage = contract.protocol === "messages" && object(value) ? messagesUsage(value.usage) : extractUsage(value)
      if (contract.strict && (contract.protocol === "messages" ?
        !object(value) || value.type !== "message" || !messageTerminal(value) : !responseTerminal(value))) throw new WarmingFailure("unsupported-warm-response")
      return usage
    }
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
