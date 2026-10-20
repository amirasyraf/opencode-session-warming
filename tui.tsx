/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui"
import { RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { randomUUID } from "node:crypto"
import { createDiagnostics, fileSink, within } from "./diagnostics.ts"
import { barCells, compactLayout, indicator, remaining, uiOptions } from "./indicator.ts"
import type { Indicator, UiOptions } from "./indicator.ts"
import { safeStatus } from "./status.ts"
import type { StatusRead, UsageStats } from "./status.ts"
import { isSupportedOpenCodeVersion } from "./compatibility.ts"
import { CONTROL_TIMEOUT_MS, controlResults, parseWarmingArguments } from "./controls.ts"
import type { ControlAction, ControlResult } from "./controls.ts"
import { WarmingRpc } from "./rpc.ts"

type Context = Plugin.Context
type Location = { directory: string }
type Root = { id?: string; parent: boolean; location?: Location }
const STATUS_POLL_MS = 2000
const STATUS_TIMEOUT_MS = 1500
const NATIVE_CHECK_MS = 30_000

const controlMessages: Record<ControlResult | "unconfirmed", string> = {
  started: "Warming started with a fresh window.", stopped: "Warming stopped.",
  "already-started": "Warming is already enabled for this window.", "already-stopped": "Warming is already stopped.",
  extended: "Warming window extended.", "duration-limit": "Warming cannot be extended any further.",
  "awaiting-activity": "Warming enabled. Awaiting supported model activity.",
  "configured-off": "Warming is disabled by configuration.",
  "native-warming": "OpenCode native warming is configured; this plugin stays suspended.",
  unavailable: "Warming controls are unavailable.", "not-root": "Warming controls require a root session.",
  busy: "Warming controls are busy. Try again shortly.", expired: "The warming control request expired.",
  unconfirmed: "Warming result not confirmed. Check the indicator before retrying.",
}

/** Child views target their root parent; the server independently re-checks root metadata. */
function rootSession(context: Context, sessionID: string | undefined): Root {
  if (!sessionID) return { parent: false }
  let id: string
  try { id = context.data.session.root(sessionID) } catch { return { parent: false } }
  const info = context.data.session.get(id)
  return { id, parent: id !== sessionID, location: info?.location ? { directory: info.location.directory } : undefined }
}

function currentRoot(context: Context): Root {
  const route = context.ui.router.current()
  return route.type === "session" ? rootSession(context, route.sessionID) : { parent: false }
}

/** Mirrors OpenCode's `Config.latest`: the highest-priority document that sets `warming` wins. */
function nativeWarming(entries: unknown): boolean {
  if (!Array.isArray(entries)) return false
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index] as { type?: unknown; info?: { warming?: unknown } }
    if (entry?.type !== "document" || entry.info?.warming === undefined) continue
    const value = entry.info.warming
    return value === true || (typeof value === "object" && value !== null)
  }
  return false
}

function createWarmingClient(context: Context, log: ReturnType<typeof createDiagnostics>) {
  const rpc = context.client.rpc(WarmingRpc)
  const [reads, setReads] = createSignal<Record<string, StatusRead>>({})
  const native = new Map<string, { checkedAt: number; enabled?: boolean }>()
  const inflight = new Set<string>()
  let disposed = false
  const store = (id: string, read: StatusRead) => { if (!disposed) setReads((all) => ({ ...all, [id]: read })) }

  const checkNative = async (location: Location) => {
    const state = native.get(location.directory)
    if (state && Date.now() - state.checkedAt < NATIVE_CHECK_MS) return
    native.set(location.directory, { checkedAt: Date.now(), enabled: state?.enabled })
    try {
      const entries = await within((signal) => context.client.config.get({ location }, { signal }), STATUS_TIMEOUT_MS, "metadata-timeout")
      const enabled = nativeWarming(entries)
      native.set(location.directory, { checkedAt: Date.now(), enabled })
      // Idempotent; resent on every check so a restarted server instance learns the current configuration.
      await within((signal) => rpc.native({ enabled }, { location, signal }), STATUS_TIMEOUT_MS, "metadata-timeout")
    } catch { /* Indicator falls back to the server's last known state. */ }
  }

  const refresh = async (root: Root) => {
    const id = root.id
    if (disposed || !id || !root.location || inflight.has(id)) return
    inflight.add(id)
    void checkNative(root.location)
    try {
      const output = await within((signal) => rpc.status({ sessionID: id }, { location: root.location, signal }),
        STATUS_TIMEOUT_MS, "metadata-timeout") as { status?: unknown; native?: unknown }
      store(id, { status: safeStatus(output?.status), native: output?.native === true })
    } catch (error) {
      const type = (error as { type?: unknown })?.type
      store(id, { unavailable: type === "rpc.method_not_found" || type === "rpc.unavailable" ? "not-loaded" : "read-failed" })
    } finally { inflight.delete(id) }
  }

  const off = rpc.events.on("status", (event) => {
    const data = event.data as { sessionID?: unknown; status?: unknown }
    const status = safeStatus(data?.status)
    if (status && status.sessionID === data.sessionID) store(status.sessionID, { status, native: reads()[status.sessionID]?.native })
  })

  const control = async (action: ControlAction, root: Root, durationMs?: number): Promise<ControlResult | "unconfirmed"> => {
    if (!root.id || !root.location) return "unavailable"
    const input = { requestID: randomUUID(), sessionID: root.id, action, ...(durationMs === undefined ? {} : { durationMs }) }
    try {
      const output = await within((signal) => rpc.control(input, { location: root.location, signal }),
        CONTROL_TIMEOUT_MS, "metadata-timeout") as { result?: unknown }
      const result = controlResults.find((value) => value === output?.result)
      return result ?? "unconfirmed"
    } catch (error) {
      log({ event: "ui-status-failed", reason: "control-failed" })
      const type = (error as { type?: unknown })?.type
      return type === "rpc.method_not_found" || type === "rpc.unavailable" ? "unavailable" : "unconfirmed"
    } finally { void refresh(root) }
  }

  return {
    read: (id: string | undefined): StatusRead => (id ? reads()[id] : undefined) ?? {},
    refresh, control,
    dispose() { disposed = true; off() },
  }
}

type WarmingClient = ReturnType<typeof createWarmingClient>

function registerControls(context: Context, client: WarmingClient) {
  const pending = new Set<string>()
  let disposed = false
  const toast = (message: string, variant: "info" | "warning" = "info", title?: string) =>
    context.ui.toast.show({ ...(title ? { title } : {}), message, variant })
  const run = async (action: ControlAction, root = currentRoot(context), durationMs?: number) => {
    if (!root.id) { toast("Open a session to control warming."); return }
    if (pending.has(root.id)) { toast("A warming control request is pending."); return }
    pending.add(root.id)
    try {
      const result = await client.control(action, root, durationMs)
      if (!disposed) toast(controlMessages[result], ["started", "stopped", "extended", "already-started", "already-stopped", "awaiting-activity"].includes(result)
        ? "info" : "warning", root.parent ? "Parent session warming" : "Warming")
    } finally { pending.delete(root.id) }
  }
  const menu = async () => {
    const root = currentRoot(context)
    if (!root.id) { toast("Open a session to control warming."); return }
    await client.refresh(root)
    if (disposed) return
    const status = client.read(root.id).status
    const active = status && !status.manualStopped && ["preparing", "generating", "waiting", "sending"].includes(status.phase) && Date.now() < status.expiresAt
    const action = await context.ui.dialog.select<ControlAction>({
      title: root.parent ? "Parent session warming" : "Session warming",
      options: [
        { title: "Start warming", value: "start", description: "Start a fresh window, or await model activity", disabled: !!active || pending.has(root.id) },
        { title: "Stop warming", value: "stop", description: "Keep warming stopped until you start it", disabled: status?.manualStopped === true || pending.has(root.id) },
        { title: "Extend warming", value: "extend", description: "Add one configured window duration",
          // Only a live window (running, or manually stopped with its snapshot retained) can be extended.
          disabled: !status || !(["preparing", "generating", "waiting", "sending"].includes(status.phase) || status.manualStopped === true) ||
            !status.expiresAt || Date.now() >= status.expiresAt || pending.has(root.id) },
      ],
    })
    if (action && !disposed && currentRoot(context).id === root.id) await run(action, root)
  }
  context.keymap.layer(() => ({
    commands: [
      {
        id: "session-warming.menu", title: "Session warming", description: "Show warming controls for this session", group: "Session",
        palette: true, slash: { name: "warming", arguments: true },
        // OpenCode clears the prompt before running argument slash commands; nothing else is submitted.
        run: (input) => {
          const parsed = parseWarmingArguments(input)
          if (parsed === "invalid") { toast("Usage: /warming, /warming start, /warming stop, or /warming extend [duration]"); return }
          if (parsed === "menu") return menu()
          return typeof parsed === "string" ? run(parsed) : run(parsed.action, undefined, parsed.durationMs)
        },
      },
      { id: "session-warming.start", title: "Start warming", group: "Session", palette: true, run: () => run("start") },
      { id: "session-warming.stop", title: "Stop warming", group: "Session", palette: true, run: () => run("stop") },
      { id: "session-warming.extend", title: "Extend warming", group: "Session", palette: true, run: () => run("extend") },
    ],
  }))
  return () => { disposed = true; pending.clear() }
}

function blend(a: RGBA, b: RGBA, amount: number): RGBA {
  return RGBA.fromValues(a.r + (b.r - a.r) * amount, a.g + (b.g - a.g) * amount, a.b + (b.b - a.b) * amount)
}

function Bar(props: { context: Context; options: UiOptions; model: Indicator; width?: number }) {
  const [measured, setMeasured] = createSignal(0)
  const cells = createMemo(() => barCells(props.model, props.width ?? measured(), props.options.maxSegments))
  const columns = createMemo(() => Array.from({ length: cells().length }, (_, index) => index))
  const theme = () => props.context.theme
  const background = (index: number) => {
    const track = blend(theme().background.raised.base, theme().text.muted, 0.16)
    const cell = cells()[index]
    const fill = props.options.color ? RGBA.fromHex(cell.color) : theme().text.muted
    // Faintly tint future bands; elapsed portions retain their full colour intensity.
    const idle = 0.08
    const shade = cell.segment % 2 ? 0.88 : 1
    return blend(track, fill, (idle + (1 - idle) * cell.fill) * shade * (props.model.dimmed ? 0.45 : 1))
  }
  return (
    <box width={props.width ?? "100%"} maxWidth={256}
      height={1} flexShrink={0} flexDirection="row" onSizeChange={function () { setMeasured(this.width) }}>
      <For each={columns()}>{(index) => <box width={1} height={1} backgroundColor={background(index)} />}</For>
    </box>
  )
}

function Stat(props: { context: Context; label: string; value: string; warning?: boolean }) {
  const theme = () => props.context.theme
  return (
    <box width="100%" height={1} flexDirection="row" justifyContent="space-between" gap={1}>
      <text fg={theme().text.muted} wrapMode="none" truncate>{props.label}</text>
      <text fg={props.warning ? theme().text.feedback.warning.base : theme().text.base} flexShrink={0}>{props.value}</text>
    </box>
  )
}

function tokens(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`
  return `${(value / 1_000_000_000).toFixed(1)}B`
}

function uncachedInput(usage: UsageStats): number | undefined {
  if (usage.uncachedInputTokens !== undefined) return usage.uncachedInputTokens
  if (usage.inputTokens === undefined || usage.cachedTokens === undefined || usage.cacheWriteTokens === undefined) return
  const value = usage.inputTokens - usage.cachedTokens - usage.cacheWriteTokens
  return value >= 0 ? value : undefined
}

function hitRate(usage: UsageStats): string | undefined {
  const uncached = uncachedInput(usage)
  if (uncached === undefined || usage.cachedTokens === undefined || usage.cacheWriteTokens === undefined) return
  const total = uncached + usage.cachedTokens + usage.cacheWriteTokens
  if (total <= 0) return
  return `${Math.round(usage.cachedTokens / total * 1000) / 10}%`
}

function cacheWrite(usage: UsageStats): string | undefined {
  if (usage.cacheWriteTokens === undefined) return
  const detail = [usage.cacheWrite5mTokens === undefined ? undefined : `5m ${tokens(usage.cacheWrite5mTokens)}`,
    usage.cacheWrite1hTokens === undefined ? undefined : `1h ${tokens(usage.cacheWrite1hTokens)}`].filter(Boolean).join(", ")
  return `${tokens(usage.cacheWriteTokens)}${detail ? ` (${detail})` : ""}`
}

function metric(value: number | string | undefined): string {
  return value === undefined ? "N/A" : typeof value === "number" ? tokens(value) : value
}

function usageCapabilities(adapterID?: string) {
  const codex = adapterID === "codex"
  return { input: !codex, read: true, write: !codex, hitRate: !codex, output: true }
}

function View(props: { context: Context; client: WarmingClient; options: UiOptions; sessionID: string; sidebar?: boolean; bottom?: boolean }) {
  const dimensions = useTerminalDimensions()
  const [now, setNow] = createSignal(Date.now())
  const [measured, setMeasured] = createSignal<number>()
  const root = createMemo(() => rootSession(props.context, props.sessionID),
    undefined, { equals: (a, b) => a.id === b.id && a.parent === b.parent && a.location?.directory === b.location?.directory })
  const status = createMemo(() => props.client.read(root().id))
  const model = createMemo(() => indicator(status(), now(), props.options))
  const usage = createMemo(() => {
    const value = status().status?.usage
    return value ? { value, hitRate: hitRate(value), cacheWrite: cacheWrite(value) } : undefined
  })
  const ttl = createMemo(() => {
    const value = status().status
    return value?.ttlMs !== undefined && value.ttlEvidence !== "upstream-assumed" ? remaining(value.ttlMs) : undefined
  })
  const capabilities = createMemo(() => usageCapabilities(status().status?.adapterID))
  const targetWidth = () => props.bottom ? Math.max(0, dimensions().width - 6) : Math.max(0, Math.min(68, Math.floor((dimensions().width - 8) / 2)))
  const layout = createMemo(() => compactLayout(model(), Math.min(targetWidth(), measured() ?? targetWidth()), root().parent))
  createEffect(() => { void props.client.refresh(root()) })
  let polled = 0
  const timer = setInterval(() => {
    setNow(Date.now())
    if (Date.now() - polled >= STATUS_POLL_MS) { polled = Date.now(); void props.client.refresh(root()) }
  }, 500)
  timer.unref?.()
  onCleanup(() => clearInterval(timer))
  const theme = () => props.context.theme
  const warning = () => props.options.color && ["Stopped", "Unavailable", "Disabled"].includes(model().state)
  const warn = () => theme().text.feedback.warning.base
  return (
    <Show when={props.sidebar} fallback={
      <box width={targetWidth()} minWidth={0} flexShrink={1} height={props.bottom ? 2 : 1}
        marginLeft={props.bottom ? 3 : 0} paddingBottom={props.bottom ? 1 : 0} flexDirection="row" gap={1}
        onSizeChange={function () { setMeasured(this.width) }}>
        <Show when={layout().title}><text fg={theme().text.base} flexShrink={0}><b>{layout().title}</b></text></Show>
        <Show when={layout().barWidth > 0}><Bar context={props.context} options={props.options} model={model()} width={layout().barWidth} /></Show>
        <Show when={layout().state}><text fg={warning() ? warn() : theme().text.muted} wrapMode="none" flexShrink={0}>{layout().state}</text></Show>
        <For each={layout().fields}>{(field) => (
          <text width={field.width} fg={field.warning && props.options.color ? warn() : theme().text.base} wrapMode="none" flexShrink={0}>{field.text}</text>
        )}</For>
      </box>
    }>
      <box width="100%" flexShrink={0}>
        <box width="100%" height={1} flexDirection="row" justifyContent="space-between" gap={1}>
          <text fg={theme().text.base} flexShrink={0}><b>{root().parent ? "Parent warming" : "Warming"}</b></text>
          <text fg={warning() ? warn() : theme().text.muted} wrapMode="none" truncate>{model().state}</text>
        </box>
        <Show when={model().hasWindow}><box paddingTop={1} paddingBottom={1}><Bar context={props.context} options={props.options} model={model()} /></box></Show>
        <Show when={model().detail}><text fg={theme().text.muted} wrapMode="word">{model().detail}</text></Show>
        <Show when={status().status?.model}><Stat context={props.context} label={status().status?.providerID === "github-copilot" ? "Copilot" : "OpenAI"} value={status().status!.model!} /></Show>
        <Show when={status().status && ttl() !== undefined}><Stat context={props.context} label="Cache TTL" value={metric(ttl())} /></Show>
        <Show when={status().status}><Stat context={props.context} label="Next Request" value={metric(model().next)} /></Show>
        <Show when={status().status}><Stat context={props.context} label="Window Left" value={metric(model().left)} /></Show>
        <Show when={status().status}><Stat context={props.context} label="Requests Sent" value={String(model().completed ?? 0)} /></Show>
        <Show when={status().status && capabilities().input}><Stat context={props.context} label="Input Tokens" value={metric(usage()?.value.inputTokens)} /></Show>
        <Show when={status().status && capabilities().read}><Stat context={props.context} label="Cache Read" value={metric(usage()?.value.cachedTokens)} /></Show>
        <Show when={status().status && capabilities().write}><Stat context={props.context} label="Cache Write" value={metric(usage()?.cacheWrite)} /></Show>
        <Show when={status().status && capabilities().hitRate}><Stat context={props.context} label="Cache Hit Rate" value={metric(usage()?.hitRate)} /></Show>
        <Show when={status().status && capabilities().output}><Stat context={props.context} label="Output Tokens" value={metric(usage()?.value.outputTokens)} /></Show>
        <Show when={status().status}><Stat context={props.context} label="Failed" value={String(model().failed ?? 0)} warning={props.options.color && !!model().failed} /></Show>
      </box>
    </Show>
  )
}

export default {
  id: "session-warming.tui",
  setup(context: Context) {
    const log = createDiagnostics(fileSink())
    const config = uiOptions((context.options ?? {}) as Record<string, unknown>)
    if (!config) { log({ event: "disabled", reason: "invalid-ui-options" }); return }
    if (!config.enabled) return
    if (!isSupportedOpenCodeVersion(context.app.version)) { log({ event: "disabled", reason: "unsupported-opencode-version", version: context.app.version }); return }
    config.color = config.color && process.env.NO_COLOR === undefined
    const client = createWarmingClient(context, log)
    const disposeControls = registerControls(context, client)
    // Exactly one indicator: sidebar first, then the prompt row, then above the composer when there is no prompt.
    const [sidebars, setSidebars] = createSignal(0)
    const [prompts, setPrompts] = createSignal(0)
    const counted = (set: typeof setSidebars) => { onMount(() => set((count) => count + 1)); onCleanup(() => set((count) => count - 1)) }
    const offSidebar = context.ui.slot({
      append: "sidebar.content",
      render: (input) => { counted(setSidebars); return <View context={context} client={client} options={config} sessionID={input.sessionID} sidebar /> },
    })
    const offPrompt = context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => (
        <Show when={input.sessionID}>{(id) => {
          counted(setPrompts)
          return <Show when={!sidebars()}><View context={context} client={client} options={config} sessionID={id()} /></Show>
        }}</Show>
      ),
    })
    const offComposer = context.ui.slot({
      append: "session.composer.top",
      render: (input) => (
        <Show when={!sidebars() && !prompts()}><View context={context} client={client} options={config} sessionID={input.sessionID} bottom /></Show>
      ),
    })
    log({ event: "ui-ready", version: context.app.version })
    return () => { offSidebar(); offPrompt(); offComposer(); disposeControls(); client.dispose() }
  },
} satisfies Plugin.Definition
