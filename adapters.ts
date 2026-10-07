import { CODEX_ENDPOINT, classifyRequest, discardWarmResponse, object, warmRequest } from "./protocol.ts"
import type { Snapshot, Usage, ResponseContract } from "./protocol.ts"
import { GPT_INTERVAL_MS, GPT_TTL_MS, LEGACY_INTERVAL_MS, modernClaude, modernGPT } from "./cache-policy.ts"
import type { CacheProfile } from "./cache-policy.ts"

export type ModelContext = { providerID: string; modelID: string }
type Automatic = Pick<CacheProfile, "intervalMs" | "ttlMs" | "ttlEvidence">
export type Replay = {
  adapterID: string; strategy: "keepalive" | "native-prewarm" | "bounded-replay"
  snapshot: Snapshot; automatic: Automatic
  request(signal: AbortSignal): RequestInit
  drain(response: Response, signal: AbortSignal): Promise<Usage | undefined>
}
type CaptureResult = { replay: Replay; reason?: never } | { replay?: never; reason: string }
export type WarmingAdapter = {
  id: string
  providerID: string
  endpoints: readonly string[]
  supports(context: ModelContext): boolean
  capture(context: ModelContext, url: string, init: RequestInit): CaptureResult
}
const OPENAI_ENDPOINT = "https://api.openai.com/v1/responses"
const COPILOT_RESPONSES = "https://api.githubcopilot.com/responses"
const COPILOT_MESSAGES = "https://api.githubcopilot.com/v1/messages"
const gptProfile = (documented = false): Automatic => ({ intervalMs: GPT_INTERVAL_MS, ttlMs: GPT_TTL_MS,
  ttlEvidence: documented ? "documented" : "upstream-assumed" })

/** Small explicit registry. Protocol resemblance alone never authorizes a provider. */
const codex: WarmingAdapter = {
  id: "codex", providerID: "openai", endpoints: [CODEX_ENDPOINT], supports: (context) => context.providerID === "openai",
  capture(context, url, init) {
    const result = classifyRequest(url, init)
    if (!result.snapshot) return result
    if (result.snapshot.body.model !== context.modelID) return { reason: "model-mismatch" }
    const snapshot = result.snapshot
    return { replay: { adapterID: this.id, strategy: "keepalive", snapshot,
      automatic: modernGPT(context.modelID) ? gptProfile() : { intervalMs: LEGACY_INTERVAL_MS, ttlEvidence: "upstream-assumed" },
      request: (signal) => warmRequest(snapshot, signal), drain: discardWarmResponse } }
  },
}

function replay(adapterID: string, snapshot: Snapshot, strategy: Replay["strategy"], automatic: Automatic,
  body: Record<string, unknown>, contract: ResponseContract): Replay {
  return { adapterID, snapshot, strategy, automatic,
    request: (signal) => ({ method: "POST", headers: new Headers(snapshot.headers), body: JSON.stringify(body), signal, redirect: "error" }),
    drain: (response, signal) => discardWarmResponse(response, signal, contract) }
}

const openai: WarmingAdapter = {
  id: "openai-api", providerID: "openai", endpoints: [OPENAI_ENDPOINT], supports: (context) => context.providerID === "openai" && modernGPT(context.modelID),
  capture(context, url, init) {
    const result = classifyRequest(url, init, { endpoint: OPENAI_ENDPOINT, strict: true })
    if (!result.snapshot) return result
    const snapshot = result.snapshot
    if (snapshot.body.model !== context.modelID) return { reason: "model-mismatch" }
    const cache = snapshot.body.prompt_cache_options
    const body = { ...snapshot.body, stream: false, store: false, prompt_cache_options: { ...(object(cache) ? cache : {}), prewarm: true } }
    return { replay: replay(this.id, snapshot, "native-prewarm", gptProfile(true), body, { protocol: "responses", strict: true }) }
  },
}

/** Preserve every existing breakpoint. Mixed TTLs require the shortest selected lifetime. */
function claudeProfile(body: Record<string, unknown>): Automatic {
  const ttls: number[] = []
  const visit = (value: unknown) => {
    if (!object(value) || !object(value.cache_control)) return
    ttls.push(value.cache_control.ttl === "1h" ? 3_600_000 : 300_000)
  }
  visit(body)
  if (Array.isArray(body.tools)) body.tools.forEach(visit)
  if (Array.isArray(body.system)) body.system.forEach(visit)
  if (Array.isArray(body.messages)) for (const message of body.messages) {
    if (object(message) && Array.isArray(message.content)) message.content.forEach(visit)
  }
  const ttlMs = ttls.length ? Math.min(...ttls) : 300_000
  return { ttlMs, ttlEvidence: ttls.length ? "requested" : "upstream-assumed",
    intervalMs: ttlMs === 3_600_000 ? 3_480_000 : 240_000 }
}

const copilot: WarmingAdapter = {
  id: "github-copilot", providerID: "github-copilot", endpoints: [COPILOT_RESPONSES, COPILOT_MESSAGES], supports: (context) => context.providerID === "github-copilot" &&
    (modernGPT(context.modelID) || modernClaude(context.modelID)),
  capture(context, url, init) {
    const messages = modernClaude(context.modelID)
    const result = classifyRequest(url, init, { endpoint: messages ? COPILOT_MESSAGES : COPILOT_RESPONSES,
      protocol: messages ? "messages" : "responses", strict: true })
    if (!result.snapshot) return result
    const snapshot = result.snapshot
    if (snapshot.body.model !== context.modelID) return { reason: "model-mismatch" }
    snapshot.headers.set("x-initiator", "agent")
    const body = messages ? { ...snapshot.body, max_tokens: Math.min(Number(snapshot.body.max_tokens), 128) } :
      { ...snapshot.body, max_output_tokens: Math.min(Number(snapshot.body.max_output_tokens ?? 128), 128), tool_choice: "none", store: false }
    return { replay: replay(this.id, snapshot, "bounded-replay", messages ? claudeProfile(snapshot.body) : gptProfile(), body,
      { protocol: messages ? "messages" : "responses", strict: true, outputLimited: true }) }
  },
}

const registry = [openai, codex, copilot]
export function supportsModel(context: ModelContext): boolean { return registry.some((adapter) => adapter.supports(context)) }
export function capture(context: ModelContext, url: string, init: RequestInit): CaptureResult {
  const candidates = registry.filter((adapter) => adapter.providerID === context.providerID)
  if (!candidates.length) return { reason: "unsupported-provider" }
  const adapter = candidates.find((candidate) => candidate.endpoints.includes(url))
  if (!adapter) return { reason: "unsupported-endpoint" }
  if (!adapter.supports(context)) return { reason: "unsupported-model" }
  return adapter.capture(context, url, init)
}
