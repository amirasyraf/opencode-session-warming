/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createDiagnostics, within } from "./diagnostics.ts"
import { barCells, compactLayout, indicator, remaining, uiOptions } from "./indicator.ts"
import type { Indicator, UiOptions } from "./indicator.ts"
import { readStatus } from "./status.ts"
import type { StatusRead, UsageStats } from "./status.ts"
import { isSupportedOpenCodeVersion } from "./compatibility.ts"

function rootSession(api: TuiPluginApi): { id?: string; parent: boolean } {
  const route = api.route.current
  if (route.name !== "session" || !route.params || typeof route.params.sessionID !== "string") return { parent: false }
  let id = route.params.sessionID
  const visited = new Set<string>()
  for (let depth = 0; depth < 8; depth++) {
    if (visited.has(id)) return { parent: true }
    visited.add(id)
    const parent = api.state.session.get(id)?.parentID
    if (!parent) return { id, parent: id !== route.params.sessionID }
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
  let disposed = false
  const refresh = async () => {
    const id = root().id
    if (inFlight || disposed || !id) return
    inFlight = true
    const current = generation
    try {
      const value = await within(() => readStatus(id), 1000, "metadata-timeout")
      if (!disposed && current === generation) setStatus(value)
    } catch {
      if (!disposed && current === generation) setStatus({ unavailable: "read-failed" })
    } finally { inFlight = false }
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
