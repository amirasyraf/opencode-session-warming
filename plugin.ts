import type { Plugin } from "@opencode-ai/plugin"
import { WarmingEngine, settings } from "./engine.ts"
import { CAPTURE_HEADER } from "./protocol.ts"
import { transport } from "./transport.ts"

const hiddenAgents = new Set(["title", "summary"])
const flag = (name: string) => ["true", "1"].includes(process.env[name] ?? "")

const plugin: Plugin = async ({ client }, options = {}) => {
  const prepared = new Map<string, { messageID: string; token?: string }>()
  const reverts = new Map<string, string>()
  const diagnostic = (extra: Record<string, string | number | boolean | undefined>) => {
    if (extra.event === "stopped" && typeof extra.sessionID === "string") {
      prepared.delete(extra.sessionID)
      reverts.delete(extra.sessionID)
    }
    void client.app.log({ body: { service: "session-warming", level: "info", message: String(extra.event), extra } }).catch(() => {})
  }
  const config = settings(options)
  if (!config || !config.enabled) {
    if (!config) diagnostic({ event: "disabled", reason: "invalid-options" })
    return {}
  }
  if (flag("OPENCODE_EXPERIMENTAL_NATIVE_LLM") || flag("OPENCODE_EXPERIMENTAL_WEBSOCKETS") ||
      ["local", "dev", "beta"].includes(process.env.OPENCODE_CHANNEL ?? "")) {
    diagnostic({ event: "disabled", reason: "unsupported-transport" })
    return {}
  }
  const engine = new WarmingEngine(config, transport(), diagnostic)
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
        const result = await client.session.get({ path: { id: input.sessionID } })
        if (disposed || prepared.get(input.sessionID) !== preparation) return
        if (!result.data || result.data.parentID) { prepared.delete(input.sessionID); return }
        // Conservative guard for sessions created by unsupported/pre-release versions.
        const supported = result.data.version === "1.18.30" && input.model.providerID === "openai" && input.agent !== "compaction"
        if (!supported) {
          prepared.delete(input.sessionID)
          diagnostic({ event: "skipped", sessionID: input.sessionID, reason: "unsupported-provider-or-session-version" })
          return
        }
        const token = engine.prepare(input.sessionID, true)
        if (token) {
          preparation.token = token
          reverts.set(input.sessionID, JSON.stringify(result.data.revert ?? null))
        }
      } catch {
        if (prepared.get(input.sessionID) === preparation) prepared.delete(input.sessionID)
        diagnostic({ event: "skipped", sessionID: input.sessionID, reason: "session-metadata-unavailable" })
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
      prepared.clear()
      reverts.clear()
    },
  }
}

export default plugin
