import type { Plugin } from "@opencode-ai/plugin"
import { WarmingEngine, settings, settingsError } from "./engine.ts"
import { createDiagnostics, errorDetails, within } from "./diagnostics.ts"
import type { Diagnostic } from "./diagnostics.ts"
import { CAPTURE_HEADER } from "./protocol.ts"
import { transport } from "./transport.ts"
import { StatusPublisher } from "./status.ts"

const hiddenAgents = new Set(["title", "summary"])
const flag = (name: string) => ["true", "1"].includes(process.env[name] ?? "")

const plugin: Plugin = async ({ client }, options = {}) => {
  const prepared = new Map<string, { messageID: string; token?: string }>()
  const reverts = new Map<string, string>()
  const log = createDiagnostics((entry, signal) => client.app.log({ body: entry, signal }), { debug: options.debug === true })
  const diagnostic = (extra: Diagnostic) => {
    if (extra.event === "stopped" && typeof extra.sessionID === "string") {
      prepared.delete(extra.sessionID)
      reverts.delete(extra.sessionID)
    }
    log(extra)
  }
  const config = settings(options)
  if (!config || !config.enabled) {
    diagnostic({ event: "disabled", reason: !config ? settingsError(options) : "configured-off" })
    return {}
  }
  if (flag("OPENCODE_EXPERIMENTAL_NATIVE_LLM") || flag("OPENCODE_EXPERIMENTAL_WEBSOCKETS") ||
      ["local", "dev", "beta"].includes(process.env.OPENCODE_CHANNEL ?? "")) {
    diagnostic({ event: "disabled", reason: "unsupported-transport" })
    return {}
  }
  let engine: WarmingEngine
  const publisher = new StatusPublisher(diagnostic)
  try { engine = new WarmingEngine(config, transport(), diagnostic, undefined, (status) => publisher.publish(status)) }
  catch (error) { diagnostic({ event: "internal-error", reason: "initialization-failed", ...errorDetails(error) }); return {} }
  diagnostic({ event: "ready", version: "1.18.30", providerID: "openai", intervalMs: config.intervalMs,
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
        if (result.data.parentID) { prepared.delete(input.sessionID); return }
        // Conservative guard for sessions created by unsupported/pre-release versions.
        const supported = result.data.version === "1.18.30" && input.model.providerID === "openai" && input.agent !== "compaction"
        if (!supported) {
          prepared.delete(input.sessionID)
          diagnostic({ event: "skipped", sessionID: input.sessionID, providerID: input.model.providerID,
            version: result.data.version, reason: result.data.version !== "1.18.30" ? "unsupported-session-version" :
              input.agent === "compaction" ? "compaction" : "unsupported-provider" })
          engine.inactive(input.sessionID, result.data.version !== "1.18.30" ? "unsupported-session-version" :
            input.agent === "compaction" ? "compaction" : "unsupported-provider")
          return
        }
        const token = engine.prepare(input.sessionID, true)
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
      if (disposed || hiddenAgents.has(input.agent) || input.agent === "compaction" || input.model.providerID !== "openai") return
      const request = prepared.get(input.sessionID)
      if (request?.messageID === input.message.id && request.token) output.headers[CAPTURE_HEADER] = request.token
    },
    "experimental.session.compacting": async ({ sessionID }) => { if (!disposed) clear(sessionID, "compacting") },
    event: async ({ event }) => {
      if (disposed) return
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
      await within(() => publisher.dispose(), 2000, "metadata-timeout").catch((error: unknown) => {
        diagnostic({ event: "ui-status-failed", reason: "cleanup-failed", ...errorDetails(error) })
      })
      prepared.clear()
      reverts.clear()
    },
  }
}

export default plugin
