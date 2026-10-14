/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { KeyEvent, Renderable, TextareaRenderable } from "@opentui/core"
import type { CommandContext } from "@opentui/keymap"
import { createDiagnostics, within } from "./diagnostics.ts"
import { barCells, compactLayout, indicator, remaining, uiOptions } from "./indicator.ts"
import type { Indicator, UiOptions } from "./indicator.ts"
import { readStatus } from "./status.ts"
import type { StatusRead, UsageStats } from "./status.ts"
import { isSupportedOpenCodeVersion } from "./compatibility.ts"
import { ControlClient, parseWarmingCommand } from "./controls.ts"
import type { ControlAction, ControlResult } from "./controls.ts"

const controlMessages: Record<ControlResult | "unconfirmed", string> = {
  started: "Warming started with a fresh window.", stopped: "Warming stopped.",
  "already-started": "Warming is already enabled for this window.", "already-stopped": "Warming is already stopped.",
  "awaiting-activity": "Warming enabled. Awaiting supported model activity.",
  "configured-off": "Warming is disabled by configuration.", unavailable: "Warming controls are unavailable.",
  "not-root": "Warming controls require a root session.", "unsupported-session": "This session's OpenCode version is unsupported.",
  busy: "Warming controls are busy. Try again shortly.", expired: "The warming control request expired.",
  unconfirmed: "Warming result not confirmed. Check the indicator before retrying.",
}

function registerControls(api: TuiPluginApi) {
  const controls = new ControlClient(async (command, signal) => {
    const result = await api.client.tui.publish({ body: { type: "tui.command.execute", properties: { command } } }, { signal })
    if (result.error) throw new Error("control-delivery-failed")
  })
  const pending = new Set<string>()
  let disposed = false
  const run = async (action: ControlAction, root = rootSession(api)) => {
    if (!root.id) { api.ui.toast({ message: "Open a session to control warming.", variant: "info" }); return }
    const sessionID = root.id
    if (pending.has(sessionID)) { api.ui.toast({ message: "A warming control request is pending.", variant: "info" }); return }
    pending.add(sessionID)
    try {
      const result = await controls.request(action, sessionID)
      if (!disposed) api.ui.toast({ title: root.parent ? "Parent session warming" : "Warming",
        message: controlMessages[result], variant: ["started", "stopped", "already-started", "already-stopped", "awaiting-activity"].includes(result) ? "info" : "warning" })
    } finally { pending.delete(sessionID) }
  }
  const menu = async () => {
    const root = rootSession(api)
    if (!root.id) { api.ui.toast({ message: "Open a session to control warming.", variant: "info" }); return }
    const status = await within(() => readStatus(root.id!), 1000, "metadata-timeout").catch(() => ({} as StatusRead))
    if (disposed || rootSession(api).id !== root.id) return
    const active = status.status && !status.status.manualStopped && ["preparing", "generating", "waiting", "sending"].includes(status.status.phase) && Date.now() < status.status.expiresAt
    api.ui.dialog.replace(() => <api.ui.DialogSelect<ControlAction>
      title={root.parent ? "Parent session warming" : "Session warming"}
      options={[
        { title: "Start warming", value: "start", description: "Start a fresh window, or await model activity", disabled: !!active || pending.has(root.id!) },
        { title: "Stop warming", value: "stop", description: "Keep warming stopped until you start it", disabled: status.status?.manualStopped || pending.has(root.id!) },
      ]}
      onSelect={(option) => { api.ui.dialog.clear(); void run(option.value, root) }} />)
  }
  const intercept = (context: CommandContext<Renderable, KeyEvent>) => {
    const editor = api.renderer.currentFocusedEditor as TextareaRenderable | null
    const traits = editor?.traits as (TextareaRenderable["traits"] & { owner?: string; role?: string }) | undefined
    if (disposed || !editor || traits?.owner !== "opencode" || traits.role !== "prompt" || traits.status === "SHELL") return false
    const command = parseWarmingCommand(editor.plainText)
    if (!command) return false
    context.event?.preventDefault()
    context.event?.stopPropagation()
    if (command === "invalid") {
      api.ui.toast({ message: "Usage: /warming start or /warming stop", variant: "info" })
      return
    }
    editor.extmarks.clear()
    editor.clear()
    if (command === "menu") void menu()
    else void run(command)
  }
  const offCommands = api.keymap.registerLayer({ priority: 100000, commands: [
    { name: "input.submit", hidden: true, run: intercept },
    { name: "prompt.submit", hidden: true, run: intercept },
    { name: "session-warming.menu", namespace: "palette", title: "Session warming", category: "Session", slashName: "warming", run: () => { void menu() } },
    { name: "session-warming.start", namespace: "palette", title: "Start warming", category: "Session", run: () => { api.ui.dialog.clear(); void run("start") } },
    { name: "session-warming.stop", namespace: "palette", title: "Stop warming", category: "Session", run: () => { api.ui.dialog.clear(); void run("stop") } },
  ] })
  const offEvent = api.event.on("tui.command.execute", (event) => controls.receive(event.properties.command))
  api.lifecycle.onDispose(() => { disposed = true; offCommands(); offEvent(); controls.dispose(); pending.clear() })
}

function rootSession(api: TuiPluginApi, sessionID?: string): { id?: string; parent: boolean } {
  const route = api.route.current
  let current = sessionID
  if (!current) {
    if (route.name !== "session" || !route.params || typeof route.params.sessionID !== "string") return { parent: false }
    current = route.params.sessionID
  }
  let id = current
  const visited = new Set<string>()
  for (let depth = 0; depth < 8; depth++) {
    if (visited.has(id)) return { parent: true }
    visited.add(id)
    const parent = api.state.session.get(id)?.parentID
    if (!parent) return { id, parent: id !== current }
    id = parent
  }
  return { parent: true }
}

function blend(a: RGBA, b: RGBA, amount: number): RGBA {
  return RGBA.fromValues(a.r + (b.r - a.r) * amount, a.g + (b.g - a.g) * amount, a.b + (b.b - a.b) * amount)
}

function Bar(props: { api: TuiPluginApi; options: UiOptions; model: Indicator; width?: number }) {
  const [measured, setMeasured] = createSignal(0)
  const cells = createMemo(() => barCells(props.model, props.width ?? measured(), props.options.maxSegments))
  const columns = createMemo(() => Array.from({ length: cells().length }, (_, index) => index))
  const theme = () => props.api.theme.current
  const background = (index: number) => {
    const track = blend(theme().backgroundPanel, theme().textMuted, 0.16)
    const cell = cells()[index]
    const fill = props.options.color ? RGBA.fromHex(cell.color) : theme().textMuted
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

function Stat(props: { api: TuiPluginApi; label: string; value: string; warning?: boolean }) {
  const theme = () => props.api.theme.current
  return (
    <box width="100%" height={1} flexDirection="row" justifyContent="space-between" gap={1}>
      <text fg={theme().textMuted} wrapMode="none" truncate>{props.label}</text>
      <text fg={props.warning ? theme().warning : theme().text} flexShrink={0}>{props.value}</text>
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

function View(props: { api: TuiPluginApi; options: UiOptions; sidebar?: boolean; bottom?: boolean }) {
  const dimensions = useTerminalDimensions()
  const [now, setNow] = createSignal(Date.now())
  const [status, setStatus] = createSignal<StatusRead>({})
  const [measured, setMeasured] = createSignal<number>()
  const root = createMemo(() => rootSession(props.api), undefined, { equals: (a, b) => a?.id === b?.id && a?.parent === b?.parent })
  const model = createMemo(() => indicator(status(), now(), props.options))
  const usage = createMemo(() => {
    const value = status().status?.usage
    return value ? { value, uncached: uncachedInput(value), hitRate: hitRate(value), cacheWrite: cacheWrite(value) } : undefined
  })
  const ttl = createMemo(() => {
    const value = status().status
    return value?.ttlMs !== undefined && value.ttlEvidence !== "upstream-assumed" ? remaining(value.ttlMs) : undefined
  })
  const capabilities = createMemo(() => usageCapabilities(status().status?.adapterID))
  const targetWidth = () => props.bottom ? Math.max(0, dimensions().width - 6) : Math.max(0, Math.min(68, Math.floor((dimensions().width - 8) / 2)))
  const layout = createMemo(() => compactLayout(model(), Math.min(targetWidth(), measured() ?? targetWidth()), root().parent))
  let generation = 0
  let inFlight = false
  let refreshQueued = false
  let disposed = false
  const refresh = async () => {
    const id = root().id
    if (disposed || !id) return
    if (inFlight) { refreshQueued = true; return }
    inFlight = true
    const current = generation
    try {
      const value = await within(() => readStatus(id), 1000, "metadata-timeout")
      if (!disposed && current === generation) setStatus(value)
    } catch {
      if (!disposed && current === generation) setStatus({ unavailable: "read-failed" })
    } finally {
      inFlight = false
      if (refreshQueued && !disposed) { refreshQueued = false; void refresh() }
    }
  }
  createEffect(() => {
    root().id
    generation++
    setStatus({})
    void refresh()
  })
  const timer = setInterval(() => { setNow(Date.now()); void refresh() }, 500)
  timer.unref()
  onCleanup(() => { disposed = true; generation++; clearInterval(timer) })
  const theme = () => props.api.theme.current
  const warning = () => props.options.color && (model().state === "Stopped" || model().state === "Unavailable")
  return (
    <Show when={props.sidebar} fallback={
      <box width={targetWidth()} minWidth={0} flexShrink={1} height={props.bottom ? 2 : 1}
        marginLeft={props.bottom ? 3 : 0} paddingBottom={props.bottom ? 1 : 0} flexDirection="row" gap={1}
        onSizeChange={function () { setMeasured(this.width) }}>
        <Show when={layout().title}><text fg={theme().text} flexShrink={0}><b>{layout().title}</b></text></Show>
        <Show when={layout().barWidth > 0}><Bar api={props.api} options={props.options} model={model()} width={layout().barWidth} /></Show>
        <Show when={layout().state}><text fg={warning() ? theme().warning : theme().textMuted} wrapMode="none" flexShrink={0}>{layout().state}</text></Show>
        <For each={layout().fields}>{(field) => (
          <text width={field.width} fg={field.warning && props.options.color ? theme().warning : theme().text} wrapMode="none" flexShrink={0}>{field.text}</text>
        )}</For>
      </box>
    }>
      <box width="100%" flexShrink={0}>
        <box width="100%" height={1} flexDirection="row" justifyContent="space-between" gap={1}>
          <text fg={theme().text} flexShrink={0}><b>Warming</b></text>
          <text fg={warning() ? theme().warning : theme().textMuted} wrapMode="none" truncate>{model().state}</text>
        </box>
        <Show when={model().hasWindow}><box paddingTop={1} paddingBottom={1}><Bar api={props.api} options={props.options} model={model()} /></box></Show>
        <Show when={model().detail}><text fg={theme().textMuted} wrapMode="word">{model().detail}</text></Show>
        <Show when={status().status?.model}><Stat api={props.api} label={status().status?.providerID === "github-copilot" ? "Copilot" : "OpenAI"} value={status().status!.model!} /></Show>
        <Show when={status().status && ttl() !== undefined}><Stat api={props.api} label="Cache TTL" value={metric(ttl())} /></Show>
        <Show when={status().status}><Stat api={props.api} label="Next Request" value={metric(model().next)} /></Show>
        <Show when={status().status}><Stat api={props.api} label="Window Left" value={metric(model().left)} /></Show>
        <Show when={status().status}><Stat api={props.api} label="Requests Sent" value={String(model().completed ?? 0)} /></Show>
        <Show when={status().status && capabilities().input}><Stat api={props.api} label="Input Tokens" value={metric(usage()?.value.inputTokens)} /></Show>
        <Show when={status().status && capabilities().read}><Stat api={props.api} label="Cache Read" value={metric(usage()?.value.cachedTokens)} /></Show>
        <Show when={status().status && capabilities().write}><Stat api={props.api} label="Cache Write" value={metric(usage()?.cacheWrite)} /></Show>
        <Show when={status().status && capabilities().hitRate}><Stat api={props.api} label="Cache Hit Rate" value={metric(usage()?.hitRate)} /></Show>
        <Show when={status().status && capabilities().output}><Stat api={props.api} label="Output Tokens" value={metric(usage()?.value.outputTokens)} /></Show>
        <Show when={status().status}><Stat api={props.api} label="Failed" value={String(model().failed ?? 0)} warning={props.options.color && !!model().failed} /></Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api, options = {}) => {
  const log = createDiagnostics((entry, signal) => api.client.app.log(entry, { signal }))
  const config = uiOptions(options)
  if (!config) { log({ event: "disabled", reason: "invalid-ui-options" }); return }
  if (!config.enabled) return
  if (!isSupportedOpenCodeVersion(api.app.version)) { log({ event: "disabled", reason: "unsupported-ui-version" }); return }
  config.color = config.color && process.env.NO_COLOR === undefined
  registerControls(api)
  const [sidebars, setSidebars] = createSignal(0)
  const Sidebar = () => {
    onMount(() => setSidebars((count) => count + 1))
    onCleanup(() => setSidebars((count) => count - 1))
    return <View api={api} options={config} sidebar />
  }
  const noPrompt = () => {
    const route = api.route.current
    if (route.name !== "session" || !route.params || typeof route.params.sessionID !== "string") return false
    const id = route.params.sessionID
    return !!api.state.session.get(id)?.parentID || api.state.session.permission(id).length > 0 || api.state.session.question(id).length > 0
  }
  api.slots.register({
    // OpenCode 1.18.x places LSP at 300 and Todos at 400.
    order: 350,
    slots: {
      sidebar_content: () => <Sidebar />,
      session_prompt_right: () => <Show when={!sidebars()}><View api={api} options={config} /></Show>,
      app_bottom: () => <Show when={!sidebars() && noPrompt()}><View api={api} options={config} bottom /></Show>,
    },
  })
  log({ event: "ui-ready", version: api.app.version })
}

export default { id: "opencode-session-warming-ui", tui } satisfies TuiPluginModule
