/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createDiagnostics, within } from "./diagnostics.ts"
import { indicator, uiOptions } from "./indicator.ts"
import type { UiOptions } from "./indicator.ts"
import { readStatus } from "./status.ts"
import type { StatusRead } from "./status.ts"

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

function View(props: { api: TuiPluginApi; options: UiOptions }) {
  const dimensions = useTerminalDimensions()
  const [now, setNow] = createSignal(Date.now())
  const [status, setStatus] = createSignal<StatusRead>({})
  const root = createMemo(() => rootSession(props.api), undefined, { equals: (a, b) => a?.id === b?.id && a?.parent === b?.parent })
  const width = () => dimensions().width - (root().parent ? 6 : 0)
  const model = createMemo(() => indicator(status(), now(), width(), props.options.maxSegments, props.options))
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
  const showBar = () => width() >= 50 && model().cells.length > 0
  const title = () => root().parent ? "Parent warming" : "Warming"
  return (
    <box width="100%" height={1} flexShrink={0} paddingLeft={1} backgroundColor={theme().backgroundPanel} flexDirection="row" gap={1}>
      <text fg={theme().text} flexShrink={0}>{title()}</text>
      <Show when={showBar()}>
        <box flexDirection="row" height={1} gap={1} flexShrink={0}>
          <For each={model().cells}>{(cell) => (
            <box width={2} height={1} flexDirection="row">
              <For each={[0, 1]}>{(part) => (
                <box width={1} height={1} backgroundColor={cell.fill > part ?
                  (props.options.color ? cell.color : theme().textMuted) : theme().border}>
                  <text fg={cell.fill > part ? (props.options.color ? "#111111" : theme().background) : theme().text}
                    wrapMode="none">{part === 0 ? cell.glyph : " "}</text>
                </box>
              )}</For>
            </box>
          )}</For>
        </box>
      </Show>
      <text fg={theme().textMuted} wrapMode="none" truncate flexShrink={1}>
        {root().id ? (width() < 70 ? model().compact : model().summary) : "awaiting session"}
      </text>
    </box>
  )
}

const tui: TuiPlugin = async (api, options = {}) => {
  const log = createDiagnostics((entry, signal) => api.client.app.log(entry, { signal }))
  const config = uiOptions(options)
  if (!config) {
    log({ event: "disabled", reason: "invalid-ui-options" }); return
  }
  if (!config.enabled) return
  if (api.app.version !== "1.18.30") { log({ event: "disabled", reason: "unsupported-ui-version" }); return }
  config.color = config.color && process.env.NO_COLOR === undefined
  api.slots.register({
    slots: { app_bottom: () => <View api={api} options={config} /> },
  })
  log({ event: "ui-ready", version: api.app.version })
}

export default { id: "opencode-session-warming-ui", tui } satisfies TuiPluginModule
