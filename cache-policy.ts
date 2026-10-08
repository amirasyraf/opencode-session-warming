import { object } from "./protocol.ts"
import { DAY_MS } from "./journal-schema.ts"
import type { JournalOptions } from "./journal-schema.ts"

export type Override = { enabled?: boolean; intervalMs?: number }
export type ProviderOverride = Override & { models?: Record<string, Override> }
export type Settings = Override & {
  enabled: boolean; durationMs: number; debug?: boolean
  providers?: Record<string, ProviderOverride>
  journal?: JournalOptions
}
export type CacheProfile = {
  ttlMs?: number; ttlEvidence: "documented" | "upstream-assumed" | "requested"
  intervalMs: number; intervalSource: "automatic" | "global" | "provider" | "model"
  enabled: boolean
}
export const MAX_TIMER = 2_147_483_647
export const GPT_TTL_MS = 1_800_000
export const GPT_INTERVAL_MS = 1_680_000
export const LEGACY_INTERVAL_MS = 240_000
const identifier = /^[A-Za-z0-9_.-]{1,160}$/
const timer = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMER

export function settingsError(options: Record<string, unknown> = {}): string | undefined {
  if (Object.keys(options).some((key) => !["enabled", "intervalMs", "durationMs", "debug", "providers", "journal"].includes(key))) return "unknown-option"
  if (options.enabled !== undefined && typeof options.enabled !== "boolean") return "invalid-enabled"
  if (options.debug !== undefined && typeof options.debug !== "boolean") return "invalid-debug"
  if (options.journal !== undefined) {
    const value = options.journal
    if (!object(value) || Object.keys(value).some((key) => !["enabled", "retentionDays", "maxBytes"].includes(key))) return "invalid-journal"
    if (value.enabled !== undefined && typeof value.enabled !== "boolean") return "invalid-journal-enabled"
    if (value.retentionDays !== undefined && (typeof value.retentionDays !== "number" || !Number.isSafeInteger(value.retentionDays) ||
      value.retentionDays <= 0 || !Number.isSafeInteger(value.retentionDays * DAY_MS) || value.retentionDays * DAY_MS > 8_640_000_000_000_000)) return "invalid-journal-retention"
    if (value.maxBytes !== undefined && (typeof value.maxBytes !== "number" || !Number.isSafeInteger(value.maxBytes) || value.maxBytes < 8 * 1024 * 1024)) return "invalid-journal-max-bytes"
  }
  const duration = options.durationMs ?? 3_600_000
  if (!timer(duration)) return "invalid-duration"
  if (options.intervalMs !== undefined && !timer(options.intervalMs)) return "invalid-interval"
  if (typeof options.intervalMs === "number" && options.intervalMs >= (duration as number)) return "interval-not-less-than-duration"
  const providers = options.providers
  if (providers === undefined) return
  if (!object(providers) || Object.keys(providers).length > 128) return "invalid-overrides"
  for (const [providerID, value] of Object.entries(providers)) {
    if (!identifier.test(providerID) || !object(value) || Object.keys(value).some((field) => !["enabled", "intervalMs", "models"].includes(field)) ||
      (value.enabled !== undefined && typeof value.enabled !== "boolean") ||
      (value.intervalMs !== undefined && !timer(value.intervalMs))) return "invalid-overrides"
    if (value.models === undefined) continue
    if (!object(value.models) || Object.keys(value.models).length > 128) return "invalid-overrides"
    for (const [modelID, model] of Object.entries(value.models)) {
      if (!identifier.test(modelID) || !object(model) || Object.keys(model).some((field) => !["enabled", "intervalMs"].includes(field)) ||
        (model.enabled !== undefined && typeof model.enabled !== "boolean") ||
        (model.intervalMs !== undefined && !timer(model.intervalMs))) return "invalid-overrides"
    }
  }
}

export function settings(options: Record<string, unknown> = {}): Settings | undefined {
  if (settingsError(options)) return
  // Copy validated options: caller mutation cannot change an active policy.
  return { ...JSON.parse(JSON.stringify(options)), enabled: options.enabled ?? true,
    durationMs: options.durationMs ?? 3_600_000, debug: options.debug ?? false,
    journal: { enabled: true, retentionDays: 365, ...(options.journal as object | undefined) } }
}

export function resolvePolicy(config: Settings, providerID: string, modelID: string,
  automatic: Pick<CacheProfile, "intervalMs" | "ttlMs" | "ttlEvidence">): CacheProfile {
  const provider = Object.hasOwn(config.providers ?? {}, providerID) ? config.providers![providerID] : undefined
  const model = provider?.models && Object.hasOwn(provider.models, modelID) ? provider.models[modelID] : undefined
  const intervalMs = model?.intervalMs ?? provider?.intervalMs ?? config.intervalMs ?? automatic.intervalMs
  const intervalSource = model?.intervalMs !== undefined ? "model" : provider?.intervalMs !== undefined ? "provider" :
    config.intervalMs !== undefined ? "global" : "automatic"
  return { ...automatic, intervalMs, intervalSource, enabled: config.enabled && (model?.enabled ?? provider?.enabled ?? true) }
}

export function initialProfile(modelID: string): Pick<CacheProfile, "intervalMs" | "ttlMs" | "ttlEvidence"> {
  return modernGPT(modelID) ? { intervalMs: GPT_INTERVAL_MS, ttlMs: GPT_TTL_MS, ttlEvidence: "upstream-assumed" } :
    modernClaude(modelID) ? { intervalMs: LEGACY_INTERVAL_MS, ttlMs: 300000, ttlEvidence: "upstream-assumed" } :
      { intervalMs: LEGACY_INTERVAL_MS, ttlEvidence: "upstream-assumed" }
}

/** Version parsing is numeric and anchored, never a substring/lexical comparison. */
export function modernGPT(id: string): boolean {
  const version = /^gpt-(\d+)(?:\.(\d+))?(?:-[a-z0-9]+)*$/.exec(id)
  return !!version && (Number(version[1]) > 5 || (Number(version[1]) === 5 && Number(version[2] ?? 0) >= 6))
}

export function modernClaude(id: string): boolean {
  const version = /^claude-(?:sonnet|opus)-(\d+)(?:[.-](\d{1,2}))?(?:-[a-z0-9]+)*$/.exec(id)
  return !!version && Number(version[1]) >= 5
}
