import { appendFile, mkdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type Diagnostic = { event: string; sessionID?: string; [key: string]: string | number | boolean | undefined }
export type Level = "debug" | "info" | "warn" | "error"
export type LogEntry = { service: string; level: Level; message: string; extra: Diagnostic }
type Sink = (entry: LogEntry, signal: AbortSignal) => Promise<unknown>

/** Only our own fixed codes are logged, never an exception's message or stack. */
export class WarmingFailure extends Error {
  code: string
  constructor(code: string) { super(code); this.name = "WarmingFailure"; this.code = code }
}

const networkCodes = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT",
  "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT"])
const ownCodes = new Set(["metadata-timeout", "logger-timeout", "log-rejected", "unsupported-warm-response",
  "invalid-sse-json", "invalid-warm-json", "warm-response-too-large", "warm-frame-too-large", "stream-truncated", "stream-failed", "stream-incomplete"])
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

export function errorDetails(error: unknown): { errorCategory: string; errorCode?: string } {
  if (error instanceof WarmingFailure && ownCodes.has(error.code)) {
    return { errorCategory: error.code.endsWith("timeout") ? "timeout" : "protocol", errorCode: error.code }
  }
  if (record(error)) {
    const code = typeof error.code === "string" ? error.code : record(error.cause) ? error.cause.code : undefined
    if (typeof code === "string" && networkCodes.has(code)) return { errorCategory: "network", errorCode: code }
    if (error.name === "TimeoutError") return { errorCategory: "timeout" }
    if (error.name === "AbortError") return { errorCategory: "aborted" }
    if (error.name === "SyntaxError") return { errorCategory: "parse" }
  }
  return { errorCategory: "unknown" }
}

/** Bounds a hook/logger call even if its transport ignores cancellation. */
export async function within<T>(operation: (signal: AbortSignal) => Promise<T>, ms: number, code: string): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(code); reject(new WarmingFailure(code)) }, ms)
        timer.unref()
      }),
    ])
  } finally { if (timer) clearTimeout(timer) }
}

/** Settle on local abort even if a wrapped provider fetch ignores its signal. */
export function abortableFetch(fetcher: typeof fetch, url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason) }
    if (signal.aborted) { reject(signal.reason); return }
    signal.addEventListener("abort", abort, { once: true })
    Promise.resolve().then(() => fetcher(url, init)).then((response) => {
      signal.removeEventListener("abort", abort)
      if (signal.aborted) { void response.body?.cancel().catch(() => {}); return }
      resolve(response)
    }, (error: unknown) => { signal.removeEventListener("abort", abort); reject(error) })
  })
}

const fields = new Set(["event", "sessionID", "reason", "providerID", "model", "attemptID", "attempt", "requestID",
  "windowID", "ordinaryCallID", "userMessageID", "configuredModelID", "startedAt", "completedAt",
  "status", "elapsedMs", "nextAttemptAt", "expiresAt", "intervalMs", "durationMs", "timeoutMs", "metadataTimeoutMs",
  "inputTokens", "cachedTokens", "outputTokens", "cacheWriteTokens", "cacheWrite5mTokens", "cacheWrite1hTokens", "outputLimitReached",
  "adapterID", "strategy", "ttlMs", "ttlEvidence", "intervalSource", "errorCategory", "errorCode", "retryable", "version", "dropped"])

function safeDiagnostic(value: Diagnostic): Diagnostic {
  const safe: Diagnostic = { event: "diagnostic" }
  for (const [key, item] of Object.entries(value)) {
    if (!fields.has(key)) continue
    if (typeof item === "number" && Number.isFinite(item)) safe[key] = item
    else if (typeof item === "boolean") safe[key] = item
    else if (typeof item === "string" && /^[A-Za-z0-9_.:/-]{1,160}$/.test(item)) safe[key] = item
  }
  return safe
}

function levelFor(value: Diagnostic): Level {
  if (value.event === "internal-error" || (value.event === "disabled" && value.reason !== "configured-off" && value.reason !== "unsupported-transport")) return "error"
  if (value.event === "warm-failed" || value.event === "capture-failed" || value.event === "ui-status-failed" || value.event === "policy-warning" || value.event === "journal-degraded" ||
      (value.event === "warm-aborted" && value.reason === "request-timeout") ||
      (value.event === "skipped" && value.reason === "session-metadata-unavailable")) return "warn"
  if (["scheduled", "warm-started", "ordinary-usage", "window-started", "window-ended"].includes(value.event) ||
      (value.event === "stopped" && value.reason === "ordinary-activity")) return "debug"
  return "info"
}

export function fallbackPath(): string {
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode", "session-warming-fallback.log")
}

async function appendFallback(entry: LogEntry): Promise<void> {
  const path = fallbackPath()
  await mkdir(dirname(path), { recursive: true })
  const size = await stat(path).then((file) => file.size, () => 0)
  if (size >= 1024 * 1024) return
  await appendFile(path, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 })
}

/** Fire-and-forget, at most eight sink calls; a failed sink is retired until restart. */
export function createDiagnostics(sink: Sink, options: {
  debug?: boolean; timeoutMs?: number; fallback?: (entry: LogEntry) => Promise<void>; onDegraded?: (value: Diagnostic) => void
} = {}) {
  let inFlight = 0
  let dropped = 0
  let degraded = false
  let fallbackCount = 0
  const fallback = options.fallback ?? appendFallback
  const fallbackWrite = (entry: LogEntry) => {
    if (fallbackCount++ >= 10) return
    try { void Promise.resolve(fallback(entry)).catch(() => {}) } catch { /* Last-resort diagnostics must not affect the TUI. */ }
  }
  return (diagnostic: Diagnostic): void => {
    const extra = safeDiagnostic(diagnostic)
    const level = levelFor(extra)
    if (level === "debug" && !options.debug) return
    const entry: LogEntry = { service: "session-warming", level, message: `[session-warming] ${extra.event}`, extra }
    if (degraded) { fallbackWrite(entry); return }
    if (inFlight >= 8) { dropped++; return }
    if (dropped) { extra.dropped = dropped; dropped = 0 }
    inFlight++
    void within(async (signal) => {
      const result = await sink(entry, signal)
      if (record(result) && result.error !== undefined && result.error !== null) throw new WarmingFailure("log-rejected")
    }, options.timeoutMs ?? 2000, "logger-timeout").catch((error: unknown) => {
      if (!degraded) {
        degraded = true
        try { options.onDegraded?.({ event: "logging-degraded", ...errorDetails(error) }) } catch { /* Optional observer. */ }
        fallbackWrite({ service: "session-warming", level: "warn", message: "[session-warming] logging-degraded",
          extra: { event: "logging-degraded", ...errorDetails(error) } })
      }
      fallbackWrite(entry)
    }).finally(() => { inFlight-- })
  }
}
