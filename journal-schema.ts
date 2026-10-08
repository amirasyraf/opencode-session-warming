/** The journal stores metadata only. Reconstruct values; never serialize SDK/request objects. */
export const PLUGIN_VERSION = "0.1.0"
export const MAX_RECORD_BYTES = 8 * 1024
export const MAX_SEGMENT_BYTES = 4 * 1024 * 1024
export const DAY_MS = 86_400_000
export type JournalOptions = { enabled: boolean; retentionDays: number; maxBytes?: number }
export type Scalar = string | number | boolean

const events = ["run.started", "run.ended", "journal.health", "journal.policy-observed",
  "ordinary.call-started", "ordinary.step-usage", "ordinary.message-completed",
  "window.started", "window.captured", "window.capture-failed", "window.ended",
  "warm.started", "warm.completed", "warm.failed", "warm.aborted", "warming.skipped",
  "warming.policy-warning", "warming.scheduled", "plugin.disabled", "diagnostics.degraded",
  "ui.status-failed", "internal.failed"] as const
export type JournalEvent = typeof events[number]
export type JournalData = { event: JournalEvent; [key: string]: Scalar | undefined }
export type EventRecord = JournalData & {
  schema: 1; recordKind: "event"; runID: string; seq: number; eventID: string
  recordedAt: string; runElapsedMs: number; projectID?: string
}
export type SegmentHeader = {
  schema: 1; recordKind: "segment"; runID: string; pid: number; index: number
  createdAt: string; pluginVersion: string; projectID?: string; policyGeneration?: number
}
export type JournalRecord = EventRecord | SegmentHeader

export const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
export const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_.:/-]{1,160}$/.test(value)
export const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
export const timestamp = (value: unknown): value is string => typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value

const ids = new Set(["sessionID", "userMessageID", "assistantMessageID", "partID", "ordinaryCallID", "windowID",
  "attemptID", "requestID", "providerID", "modelID", "apiModelID", "version", "pluginVersion"])
const numbers = new Set(["attempt", "status", "elapsedMs", "startedAt", "completedAt", "nextAttemptAt", "expiresAt",
  "intervalMs", "durationMs", "timeoutMs", "metadataTimeoutMs", "ttlMs", "policyGeneration", "retentionDays", "maxBytes",
  "inputTokens", "cachedTokens", "outputTokens", "cacheWriteTokens", "cacheWrite5mTokens", "cacheWrite1hTokens",
  "uncachedInputTokens", "cacheReadTokens", "nonReasoningOutputTokens", "reasoningTokens", "reportedCost",
  "offered", "admitted", "droppedQueue", "droppedStorage", "droppedPressure", "droppedOversize", "unconfirmedWrite",
  "excludedMetadata", "evictedMetadata", "unattributed", "pauseStartedAt", "pauseEndedAt", "dropped"])
const booleans = new Set(["retryable", "outputLimitReached"])
const reasons = ["unclassified", "configured-off", "unsupported-transport", "ordinary-activity", "expired", "clock-gap",
  "disposed", "session-error", "deleted", "reverted", "compacting", "compacted", "compaction", "internal-error",
  "initialization-failed", "observer-failed", "write-failed", "cleanup-failed", "request-timeout", "request-failed",
  "ordinary-transport-failed", "ordinary-aborted", "ordinary-stream-error", "ordinary-stream-cancelled", "ordinary-fetch-error",
  "ordinary-http-error", "http-auth", "http-incompatible", "http-rate-limit", "http-server", "http-error", "http-400",
  "http-401", "http-403", "http-422", "refresh", "retry", "interval-exceeds-ttl", "session-metadata-unavailable",
  "unsupported-session-version", "unsupported-provider", "unsupported-endpoint", "unsupported-model", "model-mismatch",
  "unsupported-input", "unsupported-input-item", "unsupported-input-message", "unsupported-input-image", "unsupported-input-file",
  "unsupported-input-audio", "unsupported-input-function-call", "unsupported-input-function-result", "unsupported-input-reasoning",
  "unsupported-configuration-update", "unsupported-method", "unsupported-body-type", "request-too-large", "missing-bearer-auth",
  "unsupported-content-type", "non-streaming-request", "stateful-request", "server-background", "unsupported-modality",
  "provider-prewarm", "unsupported-system", "unsupported-output-limit", "unsupported-thinking-budget", "unsupported-cache-control",
  "unsupported-tools", "cache-disabled", "unsupported-request-field", "invalid-json-or-headers", "storage-error", "io-timeout",
  "pressure", "policy-unavailable", "unknown-option", "invalid-enabled", "invalid-debug", "invalid-duration", "invalid-interval",
  "interval-not-less-than-duration", "invalid-overrides", "invalid-journal", "invalid-journal-enabled", "invalid-journal-retention",
  "invalid-journal-max-bytes"]
const enums: Record<string, readonly string[]> = {
  reason: reasons,
  adapterID: ["codex", "openai-api", "github-copilot"], strategy: ["keepalive", "native-prewarm", "bounded-replay"],
  ttlEvidence: ["documented", "upstream-assumed", "requested"], intervalSource: ["automatic", "global", "provider", "model"],
  errorCategory: ["network", "timeout", "protocol", "aborted", "parse", "unknown", "auth", "other"],
  errorCode: ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENETUNREACH", "EHOSTUNREACH",
    "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "metadata-timeout", "logger-timeout", "log-rejected",
    "unsupported-warm-response", "invalid-sse-json", "invalid-warm-json", "warm-response-too-large", "warm-frame-too-large",
    "stream-truncated", "stream-failed", "stream-incomplete"],
  usageSource: ["opencode-normalized", "provider-response"], upstreamUsageAvailability: ["unknown"],
  costSource: ["opencode-step"], costUnit: ["unspecified"], finish: ["stop", "tool-calls", "length", "content-filter", "error", "other"],
}

export function safeData(value: unknown): JournalData | undefined {
  if (!object(value) || !events.includes(value.event as JournalEvent)) return
  const result: JournalData = { event: value.event as JournalEvent }
  for (const [key, item] of Object.entries(value)) {
    if (ids.has(key) && identifier(item)) result[key] = item
    else if (numbers.has(key) && typeof item === "number" && Number.isFinite(item) && item >= 0) result[key] = item
    else if (booleans.has(key) && typeof item === "boolean") result[key] = item
    else if (enums[key]?.includes(String(item))) result[key] = item as string
    else if (key === "reason") result.reason = "unclassified"
  }
  return result
}

/** Readers reject extra/invalid fields instead of exporting untrusted raw JSON. */
export function parseRecord(value: unknown): JournalRecord | undefined {
  if (!object(value) || value.schema !== 1 || !identifier(value.runID)) return
  if (value.recordKind === "segment") {
    const keys = ["schema", "recordKind", "runID", "pid", "index", "createdAt", "pluginVersion", "projectID", "policyGeneration"]
    if (Object.keys(value).some((key) => !keys.includes(key)) || !count(value.pid) || !value.pid || !count(value.index) ||
      !timestamp(value.createdAt) || !identifier(value.pluginVersion) ||
      (value.projectID !== undefined && !identifier(value.projectID)) ||
      (value.policyGeneration !== undefined && (!count(value.policyGeneration) || !value.policyGeneration))) return
    return value as SegmentHeader
  }
  if (value.recordKind !== "event" || !count(value.seq) || !value.seq || value.eventID !== `${value.runID}:${value.seq}` ||
    !timestamp(value.recordedAt) || typeof value.runElapsedMs !== "number" || !Number.isFinite(value.runElapsedMs) || value.runElapsedMs < 0 ||
    (value.projectID !== undefined && !identifier(value.projectID))) return
  const { schema, recordKind, runID, seq, eventID, recordedAt, runElapsedMs, projectID, ...data } = value
  const safe = safeData(data)
  if (!safe || Object.keys(data).some((key) => safe[key] !== data[key])) return
  return { ...safe, schema, recordKind, runID, seq, eventID, recordedAt, runElapsedMs, ...(projectID === undefined ? {} : { projectID }) } as EventRecord
}

export const diagnosticEvents: Record<string, JournalEvent> = {
  captured: "window.captured", "capture-failed": "window.capture-failed", stopped: "window.ended", "window-started": "window.started", "window-ended": "window.ended",
  "warm-started": "warm.started", "warm-completed": "warm.completed", "warm-failed": "warm.failed", "warm-aborted": "warm.aborted",
  skipped: "warming.skipped", "policy-warning": "warming.policy-warning", scheduled: "warming.scheduled", disabled: "plugin.disabled",
  "logging-degraded": "diagnostics.degraded", "ui-status-failed": "ui.status-failed", "internal-error": "internal.failed",
}
