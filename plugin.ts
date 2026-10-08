import type { Plugin } from "@opencode-ai/plugin"
import { WarmingEngine, settings, settingsError } from "./engine.ts"
import { createDiagnostics, errorDetails, within } from "./diagnostics.ts"
import type { Diagnostic } from "./diagnostics.ts"
import { CAPTURE_HEADER } from "./protocol.ts"
import { transport } from "./transport.ts"
import { StatusPublisher } from "./status.ts"
import { isSupportedOpenCodeVersion, SUPPORTED_OPENCODE_VERSION_RANGE } from "./compatibility.ts"
import { supportsModel } from "./adapters.ts"
import type { ModelContext } from "./adapters.ts"
import { Journal } from "./journal.ts"
import { OrdinaryObserver } from "./ordinary-observer.ts"

const context = (input: { model: { providerID: string; api: { id: string } } }): ModelContext =>
  ({ providerID: input.model.providerID, modelID: input.model.api.id })

const hiddenAgents = new Set(["title", "summary"])
const flag = (name: string) => ["true", "1"].includes(process.env[name] ?? "")

const plugin: Plugin = async ({ client, project }, options = {}) => {
  const prepared = new Map<string, { messageID: string; token?: string }>()
  const reverts = new Map<string, string>()
  let journal: Journal | undefined
  const log = createDiagnostics((entry, signal) => client.app.log({ body: entry, signal }), {
    debug: options.debug === true, onDegraded: (value) => journal?.diagnostic(value),
  })
  const diagnostic = (extra: Diagnostic) => {
    if (extra.event === "stopped" && typeof extra.sessionID === "string") {
      prepared.delete(extra.sessionID)
      reverts.delete(extra.sessionID)
    }
    journal?.diagnostic(extra)
    log(extra)
  }
  const config = settings(options)
  if (!config || !config.enabled) {
    diagnostic({ event: "disabled", reason: !config ? settingsError(options) : "configured-off" })
    return {}
  }
  if (flag("OPENCODE_EXPERIMENTAL_NATIVE_LLM") || flag("OPENCODE_EXPERIMENTAL_WEBSOCKETS") ||
      ["local", "dev", "beta"].includes(process.env.OPENCODE_CHANNEL ?? "")) {
    if (config.journal?.enabled) journal = new Journal(config.journal, log, { projectID: project?.id, startupOnly: true })
    diagnostic({ event: "disabled", reason: "unsupported-transport" })
    await journal?.dispose()
    return {}
  }
  if (config.journal?.enabled) journal = new Journal(config.journal, log, { projectID: project?.id })
  const ordinary = journal ? new OrdinaryObserver(journal) : undefined
  let engine: WarmingEngine
  const publisher = new StatusPublisher(diagnostic)
  try { engine = new WarmingEngine(config, transport(), diagnostic, undefined, (status) => publisher.publish(status)) }
  catch (error) {
    diagnostic({ event: "internal-error", reason: "initialization-failed", ...errorDetails(error) })
    ordinary?.dispose(); await journal?.dispose(); return {}
  }
  diagnostic({ event: "ready", version: SUPPORTED_OPENCODE_VERSION_RANGE, intervalMs: config.intervalMs,
    intervalSource: config.intervalMs === undefined ? "automatic" : "global",
    durationMs: config.durationMs, timeoutMs: 30000, metadataTimeoutMs: 5000 })
  let disposed = false
  const clear = (id: string, reason: string) => {
    prepared.delete(id)
    reverts.delete(id)
    engine.invalidate(id, reason)
  }
  return {
    "chat.params": async (input) => {
      if (disposed || hiddenAgents.has(input.agent)) return
      // Invalidate before awaiting metadata: an unsupported new call still stops old warming.
      clear(input.sessionID, "ordinary-activity")
      const observedAt = Date.now()
      const preparation = { messageID: input.message.id, token: undefined as string | undefined }
      prepared.set(input.sessionID, preparation)
      try {
        const result = await within((signal) => client.session.get({ path: { id: input.sessionID }, signal }), 5000, "metadata-timeout")
        if (disposed || prepared.get(input.sessionID) !== preparation) return
        if (!result.data) {
          prepared.delete(input.sessionID)
          diagnostic({ event: "skipped", sessionID: input.sessionID, reason: "session-metadata-unavailable", status: result.response?.status })
          return
        }
        ordinary?.classify(input.sessionID, !result.data.parentID)
        if (result.data.parentID) { prepared.delete(input.sessionID); return }
        const ordinaryCallID = input.agent === "compaction" ? undefined : ordinary?.call({ sessionID: input.sessionID,
          userMessageID: input.message.id, providerID: input.model.providerID, modelID: input.model.id,
          apiModelID: input.model.api.id, at: observedAt }, result.data.version)
        // Conservative guard for sessions created by unsupported/pre-release versions.
        const supported = isSupportedOpenCodeVersion(result.data.version) && supportsModel(context(input)) && input.agent !== "compaction"
        if (!supported) {
          prepared.delete(input.sessionID)
          diagnostic({ event: "skipped", sessionID: input.sessionID, providerID: input.model.providerID,
            configuredModelID: input.model.id, model: input.model.api.id, ordinaryCallID,
            version: result.data.version, reason: !isSupportedOpenCodeVersion(result.data.version) ? "unsupported-session-version" :
              input.agent === "compaction" ? "compaction" : input.model.providerID === "github-copilot" ? "unsupported-model" : "unsupported-provider" })
          engine.inactive(input.sessionID, !isSupportedOpenCodeVersion(result.data.version) ? "unsupported-session-version" :
            input.agent === "compaction" ? "compaction" : input.model.providerID === "github-copilot" ? "unsupported-model" : "unsupported-provider", context(input))
          return
        }
        const token = engine.prepare(input.sessionID, true, context(input), { ordinaryCallID,
          userMessageID: input.message.id, configuredModelID: input.model.id })
        if (token) {
          preparation.token = token
          reverts.set(input.sessionID, JSON.stringify(result.data.revert ?? null))
        }
      } catch (error) {
        if (disposed || prepared.get(input.sessionID) !== preparation) return
        prepared.delete(input.sessionID)
        diagnostic({ event: "skipped", sessionID: input.sessionID, reason: "session-metadata-unavailable", ...errorDetails(error) })
      }
    },
    "chat.headers": async (input, output) => {
      if (disposed || hiddenAgents.has(input.agent) || input.agent === "compaction" || !supportsModel(context(input))) return
      const request = prepared.get(input.sessionID)
      if (request?.messageID === input.message.id && request.token) output.headers[CAPTURE_HEADER] = request.token
    },
    "experimental.session.compacting": async ({ sessionID }) => { if (!disposed) clear(sessionID, "compacting") },
    event: async ({ event }) => {
      if (disposed) return
      try { ordinary?.event(event) } catch { if (journal) journal.counters.excludedMetadata++ }
      if (event.type === "session.error" && event.properties.sessionID) clear(event.properties.sessionID, "session-error")
      if (event.type === "session.compacted") clear(event.properties.sessionID, "compacted")
      if (event.type === "session.deleted") {
        clear(event.properties.info.id, "deleted")
      }
      if (event.type === "session.updated") {
        const info = event.properties.info
        const before = reverts.get(info.id)
        if (before !== undefined && before !== JSON.stringify(info.revert ?? null)) clear(info.id, "reverted")
      }
      if (event.type === "message.updated") {
        const info = event.properties.info
        if (info.role === "assistant" && info.time.completed && engine.has(info.sessionID) && !info.summary) {
          diagnostic({ event: "ordinary-usage", sessionID: info.sessionID, inputTokens: info.tokens.input,
            cachedTokens: info.tokens.cache.read, outputTokens: info.tokens.output + info.tokens.reasoning })
        }
      }
    },
    dispose: async () => {
      disposed = true
      engine.dispose()
      ordinary?.dispose()
      await within(() => Promise.all([publisher.dispose(), journal?.dispose()]), 2000, "metadata-timeout").catch((error: unknown) => {
        diagnostic({ event: "ui-status-failed", reason: "cleanup-failed", ...errorDetails(error) })
      })
      prepared.clear()
      reverts.clear()
    },
  }
}

export default plugin
