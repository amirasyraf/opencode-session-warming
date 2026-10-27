import type { Plugin } from "@opencode/plugin"
import { WarmingEngine, settings, settingsError } from "./engine.ts"
import { createDiagnostics, errorDetails, fileSink, within } from "./diagnostics.ts"
import type { Diagnostic } from "./diagnostics.ts"
import { complete, observeResponse, readRequest, transport } from "./transport.ts"
import type { Observation } from "./transport.ts"
import { StatusRegistry, wireStatus } from "./status.ts"
import { isSupportedOpenCodeVersion, SUPPORTED_OPENCODE_VERSION_RANGE } from "./compatibility.ts"
import { supportsModel } from "./adapters.ts"
import type { ModelContext } from "./adapters.ts"
import { Journal } from "./journal.ts"
import { OrdinaryObserver } from "./ordinary-observer.ts"
import { ControlServer, controlRequest } from "./controls.ts"
import { WarmingRpc } from "./rpc.ts"
import type { WarmStatus } from "./status.ts"
import type { Transport } from "./transport.ts"
import { attach, detach, discard, fingerprint, locationKey } from "./resident.ts"
import type { Resident } from "./resident.ts"

type Ref = { readonly providerID: string; readonly id: string }
type Preparation = { token?: string; done: Promise<void> }
type Recovery = { context: ModelContext; configuredModelID: string }
type PublicEvent = { type: string; data?: unknown }
const PROVIDERS = ["openai", "github-copilot"] as const
const METADATA_TIMEOUT_MS = 5000
const MAX_TRACKED = 1024

function bounded<K, V>(map: Map<K, V>, key: K, value: V) {
  map.delete(key)
  map.set(key, value)
  while (map.size > MAX_TRACKED) map.delete(map.keys().next().value!)
}

/**
 * Location-level warming state that outlives a plugin scope (see resident.ts): the engine and its transport
 * registrations, the journal, and metadata caches. Hooks, RPC handlers, controls, and status rendering stay per scope.
 */
type WarmingResident = Resident & {
  engine: WarmingEngine
  http: Transport
  journal?: Journal
  log: ReturnType<typeof createDiagnostics>
  diagnostic: (value: Diagnostic) => void
  publishers: Set<(status: WarmStatus) => void>
  roots: Map<string, boolean>
  models: Map<string, string>
  recoveries: Map<string, Recovery>
  native: boolean
}

function createResident(config: NonNullable<ReturnType<typeof settings>>, options: Record<string, unknown>, print: string,
  projectID: string | undefined): WarmingResident {
  let journal: Journal | undefined
  const log = createDiagnostics(fileSink(), { debug: options.debug === true, onDegraded: (value) => journal?.diagnostic(value) })
  const diagnostic = (extra: Diagnostic) => { journal?.diagnostic(extra); log(extra) }
  if (config.journal?.enabled) journal = new Journal(config.journal, log, { projectID })
  const http = transport()
  const publishers = new Set<(status: WarmStatus) => void>()
  let engine: WarmingEngine
  try {
    engine = new WarmingEngine(config, http, diagnostic, undefined, (status) => { for (const publish of publishers) publish(status) })
  } catch (error) {
    void journal?.dispose()
    throw error
  }
  let disposed = false
  return { fingerprint: print, scopes: 0, engine, http, journal, log, diagnostic, publishers,
    roots: new Map(), models: new Map(), recoveries: new Map(), native: false,
    idle: () => engine.size === 0,
    watchIdle: (callback) => { engine.onEmpty = callback },
    dispose: async () => {
      if (disposed) return
      disposed = true
      engine.dispose()
      await within(async () => { await journal?.dispose() }, 2000, "metadata-timeout").catch((error: unknown) => {
        log({ event: "ui-status-failed", reason: "cleanup-failed", ...errorDetails(error) })
      })
    } }
}

const sessionID = (data: unknown): string | undefined =>
  typeof data === "object" && data !== null && typeof (data as { sessionID?: unknown }).sessionID === "string"
    ? (data as { sessionID: string }).sessionID : undefined

/**
 * OpenCode V2 server plugin. Ordinary root-session provider requests are observed through the session
 * `http.request` / `http.response` hooks (scoped to OpenAI and GitHub Copilot); warm replays are independent
 * HTTP calls. The TUI plugin talks to this instance only through the `session-warming` plugin RPC. The engine
 * belongs to the location's process-scoped resident, so live windows survive OpenCode's idle location eviction.
 */
export default {
  id: "session-warming",
  async setup(ctx: Plugin.Context) {
    const options = (ctx.options ?? {}) as Record<string, unknown>
    const key = locationKey(ctx.location)
    const config = settings(options)
    const disabled = (value: Diagnostic) => createDiagnostics(fileSink(), { debug: options.debug === true })(value)
    if (!config || !config.enabled) {
      await discard(key)
      disabled({ event: "disabled", reason: !config ? settingsError(options) : "configured-off" })
      return
    }
    if (!isSupportedOpenCodeVersion(ctx.app.version)) {
      await discard(key)
      disabled({ event: "disabled", reason: "unsupported-opencode-version", version: ctx.app.version })
      return
    }

    let resident: WarmingResident
    let adopted: boolean
    try {
      ({ resident, adopted } = attach(key, fingerprint(options), () => createResident(config, options, fingerprint(options), ctx.location?.project?.id)))
    } catch (error) {
      disabled({ event: "internal-error", reason: "initialization-failed", ...errorDetails(error) })
      return
    }
    const { engine, http, journal, log, diagnostic, roots, models, recoveries } = resident
    let emit: ((status: Record<string, unknown>, id: string) => Promise<void>) | undefined
    const registry = new StatusRegistry(diagnostic, (status) => emit ? emit(wireStatus(status), status.sessionID) : Promise.resolve())
    const publish = (status: WarmStatus) => registry.publish(status)
    resident.publishers.add(publish)
    const ordinary = new OrdinaryObserver(journal, (id, usage) => engine.recordOrdinaryUsage(id, usage))

    let disposed = false
    const preparations = new Map<string, Preparation>()
    const inflight = new Map<string, Observation>()

    const clear = (id: string, reason: string) => {
      preparations.delete(id)
      inflight.delete(id)
      if (reason === "deleted") { recoveries.delete(id); engine.forget(id) }
      else engine.invalidate(id, reason)
    }

    const rootOf = async (id: string): Promise<boolean> => {
      const cached = roots.get(id)
      if (cached !== undefined) return cached
      const info = await within((signal) => ctx.session.get({ sessionID: id }, { signal }), METADATA_TIMEOUT_MS, "metadata-timeout")
      const root = !info.parentID
      bounded(roots, id, root)
      return root
    }

    /** Overrides and adapters use the provider API model ID (`modelID`), not OpenCode's catalog alias. */
    const apiModel = async (ref: Ref): Promise<string> => {
      const key = `${ref.providerID}/${ref.id}`
      const cached = models.get(key)
      if (cached) return cached
      const result = await within((signal) => ctx.model.list(undefined, { signal }), METADATA_TIMEOUT_MS, "metadata-timeout") as unknown
      const list = Array.isArray(result) ? result : (result as { data?: unknown[] } | undefined)?.data ?? []
      for (const item of list as { providerID?: unknown; id?: unknown; modelID?: unknown }[]) {
        if (typeof item?.providerID === "string" && typeof item.id === "string" && typeof item.modelID === "string") {
          bounded(models, `${item.providerID}/${item.id}`, item.modelID)
        }
      }
      return models.get(key) ?? ref.id
    }

    const unsupportedReason = (context: ModelContext) =>
      PROVIDERS.includes(context.providerID as typeof PROVIDERS[number]) ? "unsupported-model" : "unsupported-provider"

    /** Each agent-loop model request is ordinary activity: invalidate first, then prepare a fresh capture. */
    const prepare = (id: string, ref: Ref): Preparation => {
      clear(id, "ordinary-activity")
      const observedAt = Date.now()
      const preparation: Preparation = { done: Promise.resolve() }
      preparations.set(id, preparation)
      const current = () => !disposed && preparations.get(id) === preparation
      preparation.done = (async () => {
        try {
          const root = await rootOf(id)
          if (!current()) return
          ordinary.classify(id, root)
          if (!root) { preparations.delete(id); recoveries.delete(id); return }
          const context: ModelContext = { providerID: ref.providerID, modelID: await apiModel(ref) }
          if (!current()) return
          const ordinaryCallID = ordinary.call({ sessionID: id, providerID: ref.providerID, modelID: ref.id,
            apiModelID: context.modelID, at: observedAt }, ctx.app.version)
          if (!supportsModel(context)) {
            preparations.delete(id)
            recoveries.delete(id)
            const reason = unsupportedReason(context)
            diagnostic({ event: "skipped", sessionID: id, providerID: context.providerID, configuredModelID: ref.id,
              model: context.modelID, ordinaryCallID, reason })
            engine.inactive(id, reason, context)
            return
          }
          preparation.token = engine.prepare(id, true, context, { ordinaryCallID, configuredModelID: ref.id })
          bounded(recoveries, id, { context, configuredModelID: ref.id })
        } catch (error) {
          if (!current()) return
          preparations.delete(id)
          diagnostic({ event: "skipped", sessionID: id, reason: "session-metadata-unavailable", ...errorDetails(error) })
        }
      })()
      return preparation
    }

    /** A primary request without a live preparation (a retry after expiry, or HTTP fallback from WebSocket). */
    const recover = (id: string, ref: Ref): string | undefined => {
      const recovery = recoveries.get(id)
      if (!recovery || roots.get(id) !== true || recovery.context.providerID !== ref.providerID || recovery.configuredModelID !== ref.id) return
      const token = engine.prepare(id, true, recovery.context, { configuredModelID: recovery.configuredModelID })
      preparations.set(id, { token, done: Promise.resolve() })
      return token
    }

    const controls = new ControlServer(async (request, current) => {
      const info = await within((signal) => ctx.session.get({ sessionID: request.sessionID }, { signal }),
        Math.max(1, request.deadlineAt - Date.now()), "metadata-timeout").catch(() => undefined)
      if (!current()) return "expired"
      if (!info) return "unavailable"
      if (info.parentID) return "not-root"
      bounded(roots, request.sessionID, true)
      if (request.action === "stop") return engine.stop(request.sessionID)
      if (request.action === "extend") return engine.extendWarming(request.sessionID, request.durationMs)
      return engine.startWarming(request.sessionID)
    })

    const registration = await ctx.rpc.register(WarmingRpc, {
      status: async (input) => {
        const id = (input as { sessionID?: unknown })?.sessionID
        const status = typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? registry.get(id) : undefined
        return { ...(status ? { status: wireStatus(status) } : {}), native: resident.native }
      },
      control: async (input) => {
        const request = controlRequest(input)
        return { result: request && !disposed ? await controls.receive(request) : "unavailable" }
      },
      native: async (input) => {
        const enabled = (input as { enabled: boolean }).enabled === true
        if (enabled !== resident.native) {
          resident.native = enabled
          diagnostic({ event: enabled ? "suspended" : "resumed", reason: "native-warming" })
          engine.suspend(enabled ? "native-warming" : undefined)
        }
        return {}
      },
    })
    emit = (status, id) => registration.events.emit("status", { sessionID: id, status })

    for (const providerID of PROVIDERS) {
      await ctx.session.hook("http.request", async (event) => {
        if (disposed || event.kind !== "primary") return
        try {
          const id = event.sessionID
          let preparation = preparations.get(id)
          if (preparation) await within(() => preparation!.done, METADATA_TIMEOUT_MS, "metadata-timeout").catch(() => {})
          preparation = preparations.get(id)
          let token = preparation?.token
          if (!token || !engine.has(id)) token = recover(id, event.model)
          if (!token || disposed) return
          const request = await readRequest(event.request)
          if ("reason" in request) {
            diagnostic({ event: "skipped", sessionID: id, providerID: event.model.providerID, configuredModelID: event.model.id, reason: request.reason })
            engine.invalidate(id, request.reason)
            return
          }
          if (preparations.get(id)?.token !== token) return
          const observation = http.capture(token, request.url, request.init)
          if (observation) inflight.set(id, observation)
        } catch (error) {
          // Capture fails open: the ordinary request is never blocked or altered.
          diagnostic({ event: "capture-failed", sessionID: event.sessionID, reason: "observer-failed", ...errorDetails(error) })
        }
      }, { providerID })

      await ctx.session.hook("http.response", (event) => {
        if (event.kind !== "primary") return
        const observation = inflight.get(event.sessionID)
        if (!observation) return
        inflight.delete(event.sessionID)
        try { event.response = observeResponse(event.response, observation) }
        catch (error) { complete(observation, false, { reason: "observer-failed", ...errorDetails(error) }) }
      }, { providerID })

      // Observation only: WebSocket traffic is invisible to HTTP hooks, so report it instead of forcing HTTP.
      await ctx.session.hook("experimental.ws.handshake", (event) => {
        if (disposed || event.kind !== "primary" || !preparations.get(event.sessionID)?.token || !engine.has(event.sessionID)) return
        diagnostic({ event: "skipped", sessionID: event.sessionID, providerID: event.model.providerID,
          configuredModelID: event.model.id, reason: "websocket-transport" })
        engine.invalidate(event.sessionID, "websocket-transport")
      }, { providerID }).catch((error: unknown) => {
        diagnostic({ event: "internal-error", reason: "observer-failed", ...errorDetails(error) })
      })
    }

    await ctx.session.hook("context", async (event) => {
      if (disposed) return
      try { await within(() => prepare(event.sessionID, event.model).done, METADATA_TIMEOUT_MS, "metadata-timeout") }
      catch (error) { diagnostic({ event: "skipped", sessionID: event.sessionID, reason: "session-metadata-unavailable", ...errorDetails(error) }) }
    })
    await ctx.session.hook("compaction", (event) => { if (!disposed) clear(event.sessionID, "compacting") })

    const events = new AbortController()
    const handle = (event: PublicEvent) => {
      try { ordinary.event(event) } catch { journal && journal.counters.excludedMetadata++ }
      const id = sessionID(event.data)
      if (!id || roots.get(id) !== true) return
      if (event.type === "session.deleted") {
        controls.cancel(id)
        clear(id, "deleted")
        roots.delete(id)
        registry.forget(id)
      } else if (event.type === "session.execution.failed") clear(id, "session-error")
      else if (event.type === "session.execution.interrupted") {
        // Agent cancellation keeps the validated outgoing snapshot replayable; it never extends the window.
        const observation = inflight.get(id)
        inflight.delete(id)
        if (observation) complete(observation, false, { reason: "ordinary-aborted" })
      } else if (event.type === "session.compaction.started") clear(id, "compacting")
      else if (event.type === "session.compaction.ended") clear(id, "compacted")
      else if (event.type.startsWith("session.revert.")) clear(id, "reverted")
    }
    void (async () => {
      let delay = 500
      while (!disposed) {
        try {
          for await (const event of ctx.event.subscribe({ signal: events.signal })) {
            if (disposed) return
            delay = 500
            handle(event as PublicEvent)
          }
        } catch { /* Reconnect below; event loss only delays invalidation, never resurrects state. */ }
        if (disposed) return
        await new Promise((resolve) => setTimeout(resolve, delay).unref?.())
        delay = Math.min(delay * 2, 30_000)
      }
    })()

    // A re-attached resident announces its live windows to this scope's status registry.
    if (adopted) { diagnostic({ event: "adopted", reason: "location-reloaded" }); engine.republish() }
    diagnostic({ event: "ready", version: SUPPORTED_OPENCODE_VERSION_RANGE, intervalMs: config.intervalMs,
      intervalSource: config.intervalMs === undefined ? "automatic" : "global",
      durationMs: config.durationMs, timeoutMs: 30000, metadataTimeoutMs: METADATA_TIMEOUT_MS })

    // Scope disposal (including OpenCode's idle location eviction) detaches; live windows keep warming.
    return async () => {
      disposed = true
      events.abort()
      controls.dispose()
      ordinary.dispose()
      resident.publishers.delete(publish)
      registry.dispose()
      preparations.clear(); inflight.clear()
      if (await detach(key, resident) === "parked") log({ event: "parked", reason: "location-disposed" })
    }
  },
} satisfies Plugin.Plugin
