/** Test-only SDK imports. Production plugins must not load Effect or the host SDK at runtime. */
import { Effect, Schema } from "effect"
import { CacheHint, GenerationOptions, LanguageModel, LLMRequest, Message, ToolDefinition } from "@opencode/ai"
import { Media } from "@opencode/ai/media"
import { AnthropicMessages } from "@opencode/ai/protocols/anthropic-messages"
import { OpenAIResponses } from "@opencode/ai/protocols/openai-responses"
import { gzipSync, gunzipSync, zstdCompressSync, zstdDecompressSync } from "node:zlib"
import { CODEX_ENDPOINT, KEEPALIVE } from "../protocol.ts"
import type { Replay } from "../adapters.ts"
import { imageURL } from "./helpers.ts"

export const providers = [
  { name: "OpenAI API", providerID: "openai", modelID: "gpt-6.1-sol", url: "https://api.openai.com/v1/responses", strategy: "native-prewarm" },
  { name: "Codex modern", providerID: "openai", modelID: "gpt-6.1-sol", url: CODEX_ENDPOINT, strategy: "keepalive" },
  { name: "Codex legacy", providerID: "openai", modelID: "gpt-5.3-codex", url: CODEX_ENDPOINT, strategy: "keepalive" },
  { name: "Copilot GPT", providerID: "github-copilot", modelID: "gpt-6.1-sol", url: "https://api.githubcopilot.com/responses", strategy: "bounded-replay" },
  ...["sonnet", "opus", "haiku"].map((family) => ({ name: `Copilot ${family}`, providerID: "github-copilot",
    modelID: `claude-${family}-5.5`, url: "https://api.githubcopilot.com/v1/messages", strategy: "bounded-replay" as const })),
] satisfies Array<{ name: string; providerID: string; modelID: string; url: string; strategy: Replay["strategy"] }>
export type ProviderCase = typeof providers[number]
export type Body = Record<string, unknown>
export const scenarios = ["plain", "tools", "updates", "attachments", "combined"] as const
export type Scenario = typeof scenarios[number]
export const encodings = [undefined, "gzip", "zstd"] as const
export type ContentEncoding = typeof encodings[number]

export const isClaude = (provider: ProviderCase) => provider.modelID.startsWith("claude-")
const cache = (ttlSeconds: number) => new CacheHint({ type: "ephemeral", ttlSeconds })

/** Generate wire JSON through the host's serializer AND its body schema, never through plugin validation. */
export async function serialize(provider: ProviderCase, scenario: Scenario = "combined", options: { disabledThinking?: boolean; ttlSeconds?: number } = {}): Promise<Body> {
  const claude = isClaude(provider)
  const route = claude ? AnthropicMessages.route : OpenAIResponses.route
  const tools = scenario === "tools" || scenario === "attachments" || scenario === "combined"
  const updates = scenario === "updates" || scenario === "combined"
  const media = scenario === "attachments" || scenario === "combined"
  const ttl = options.ttlSeconds ?? 300
  const messages = [Message.user("Fixture user question")]
  if (media) messages.push(Message.user([
    Message.media(new Media.Asset({ source: { type: "base64", data: imageURL.split(",")[1], mediaType: "image/png" } })),
    Message.media(new Media.Asset({ source: { type: "base64", data: "JVBERi0xLjQK", mediaType: "application/pdf" } }), { filename: "fixture.pdf" }),
  ]))
  if (tools) messages.push(
    Message.assistant([
      { type: "reasoning", text: "Fixture reasoning", encrypted: "fixture-signature",
        providerMetadata: { [route.providerMetadataKey ?? provider.providerID]: { reasoningEncryptedContent: "fixture-signature" } } },
      { type: "tool-call", id: "fixture-call", name: "read", input: { path: "fixture.txt" } },
    ]),
    Message.tool({ type: "tool-result", id: "fixture-call", name: "read", result: media ? { type: "content", value: [
      { type: "text", text: "Fixture tool result" },
      { type: "file", uri: imageURL, mime: "image/png", name: "fixture.png" },
      { type: "file", uri: "data:application/pdf;base64,JVBERi0xLjQK", mime: "application/pdf", name: "fixture.pdf" },
    ] } : { type: "json", value: { text: "Fixture tool result" } } }),
  )
  if (updates) messages.push(
    Message.system([{ type: "text", text: "Fixture updated instructions", cache: cache(ttl) }]),
    Message.effort({ previous: "low", effort: "high" }),
    Message.assistant("Fixture continuation after update"),
    Message.user("Fixture follow-up"),
  )
  const request = new LLMRequest({
    model: LanguageModel.make({ id: provider.modelID, provider: provider.providerID, route }),
    system: [{ type: "text", text: "Fixture stable instructions", cache: cache(ttl) }],
    messages,
    tools: tools ? [new ToolDefinition({ name: "read", description: "Read a fixture", inputSchema: {
      type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false,
    } })] : [],
    generation: new GenerationOptions({ maxTokens: 8192 }),
    providerOptions: claude ? { thinking: { type: options.disabledThinking ? "disabled" : "adaptive" }, effort: "high" } :
      { store: false, reasoningEffort: "high", reasoningSummary: "auto", include: ["reasoning.encrypted_content"] },
    promptCacheKey: "fixture-root",
  })
  // Keep the branches separate so the actual protocol-specific schemas remain type checked.
  const body = claude ? Schema.encodeSync(AnthropicMessages.protocol.body.schema)(await Effect.runPromise(AnthropicMessages.protocol.body.from(request))) :
    Schema.encodeSync(OpenAIResponses.protocol.body.schema)(await Effect.runPromise(OpenAIResponses.protocol.body.from(request)))
  return JSON.parse(JSON.stringify(body)) as Body
}

export function encode(body: Body, encoding?: ContentEncoding): Uint8Array | string {
  const text = JSON.stringify(body)
  return encoding === "gzip" ? gzipSync(text) : encoding === "zstd" ? zstdCompressSync(text) : text
}

export function decode(request: RequestInit): Body {
  const encoding = new Headers(request.headers).get("content-encoding")
  const body = request.body as Uint8Array | string
  const text = encoding === "gzip" ? gunzipSync(body as Uint8Array).toString("utf8") :
    encoding === "zstd" ? zstdDecompressSync(body as Uint8Array).toString("utf8") : String(body)
  return JSON.parse(text)
}

export function requestFor(provider: ProviderCase, body: Body, encoding?: ContentEncoding) {
  const headers = new Headers({ authorization: "Bearer fixture-contract-only", "content-type": "application/json",
    "x-initiator": "user", "idempotency-key": "ordinary-only", "session-id": "fixture-root" })
  if (encoding) headers.set("content-encoding", encoding)
  return new Request(provider.url, { method: "POST", headers, body: encode(body, encoding) as BodyInit })
}

/** Independent policy oracle. Do not derive expected input or replay controls from the adapter under test. */
export function expectedReplay(provider: ProviderCase, body: Body): Body {
  if (provider.strategy === "native-prewarm") return { ...body, stream: false, store: false, prompt_cache_options: { prewarm: true } }
  if (provider.strategy === "keepalive") return { ...body, input: [...body.input as unknown[],
    { role: "user", content: [{ type: "input_text", text: KEEPALIVE }] }], tool_choice: "none", store: false }
  return isClaude(provider) ? { ...body, max_tokens: 128 } : { ...body, max_output_tokens: 128, tool_choice: "none", store: false }
}

export function terminal(provider: ProviderCase, limited = true, sse = false): Response {
  const usage = isClaude(provider) ? { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 0, output_tokens: 1 } :
    { input_tokens: 100, input_tokens_details: { cached_tokens: 90 }, output_tokens: 1 }
  if (isClaude(provider)) {
    const stop_reason = limited ? "max_tokens" : "end_turn"
    if (!sse) return new Response(JSON.stringify({ type: "message", stop_reason, content: [], usage }))
    return new Response([
      { type: "message_start", message: { type: "message", usage } },
      { type: "message_delta", delta: { stop_reason }, usage: { output_tokens: 1 } }, { type: "message_stop" },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
  }
  const response = { object: "response", status: limited ? "incomplete" : "completed", usage,
    ...(limited ? { incomplete_details: { reason: "max_output_tokens" } } : {}) }
  return new Response(sse ? `data: ${JSON.stringify({ type: limited ? "response.incomplete" : "response.completed", response })}\n\n` : JSON.stringify(response),
    { headers: { "content-type": sse ? "text/event-stream" : "application/json" } })
}
