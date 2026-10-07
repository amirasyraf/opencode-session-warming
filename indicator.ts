import type { StatusRead, WarmStatus } from "./status.ts"

export type Cell = { color: string; fill: number; segment: number }
export type Indicator = {
  state: string; detail?: string; progress: number; hasWindow: boolean; dimmed: boolean
  completed?: number; failed?: number; next?: string; left?: string; timerWidth: number
  durationMs: number; intervalMs: number
}
export type UiOptions = { enabled: boolean; color: boolean; maxSegments?: number; showNextTimer: boolean; showRemainingTimer: boolean }
export type CompactField = { text: string; width: number; warning?: boolean }
export type CompactLayout = { title: string; state: string; fields: CompactField[]; barWidth: number }
const colors = ["#48c6e8", "#5fcaa2", "#9bcb7e", "#ffd166", "#f6a03d", "#e76a40", "#d93f3f"]

export function remaining(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  const tail = `${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${tail}` : tail
}

export function uiOptions(options: Record<string, unknown> = {}): UiOptions | undefined {
  if (Object.keys(options).some((key) => !["enabled", "color", "maxSegments", "showNextTimer", "showRemainingTimer"].includes(key))) return
  for (const key of ["enabled", "color", "showNextTimer", "showRemainingTimer"]) {
    if (options[key] !== undefined && typeof options[key] !== "boolean") return
  }
  const maxSegments = options.maxSegments
  if (maxSegments !== undefined && (typeof maxSegments !== "number" || !Number.isSafeInteger(maxSegments) || maxSegments < 1)) return
  return { enabled: options.enabled !== false, color: options.color !== false, maxSegments,
    showNextTimer: options.showNextTimer !== false, showRemainingTimer: options.showRemainingTimer !== false }
}

function stoppedReason(status: WarmStatus): string {
  if (status.reason?.startsWith("http-")) return `HTTP ${status.reason.slice(5)}`
  if (status.reason === "session-error") return "Cancelled/error"
  if (status.reason === "ordinary-activity") return "New model activity"
  if (status.reason === "clock-gap") return "Resumed late"
  return (status.reason ?? "inactive").replaceAll("-", " ")
}

/** Elapsed window time and completed counts are independent of display segmentation. */
export function indicator(read: StatusRead, now: number,
  timers: { showNextTimer?: boolean; showRemainingTimer?: boolean } = {}): Indicator {
  const empty = { progress: 0, hasWindow: false, dimmed: true, timerWidth: 5, durationMs: 0, intervalMs: 0 }
  if (!read.status) return { ...empty, state: read.unavailable ? "Unavailable" : "Inactive",
    detail: read.unavailable ? `Status ${read.unavailable.replaceAll("-", " ")}` : "Awaiting model activity" }
  const status = read.status
  const stopped = status.phase === "stopped"
  const expired = !stopped && (status.phase === "expired" || now >= status.expiresAt)
  const hasWindow = status.expiresAt > status.startedAt
  const elapsed = Math.max(0, Math.min(now, status.stoppedAt ?? now) - status.startedAt)
  const progress = hasWindow ? Math.min(1, elapsed / status.durationMs) : 0
  const state = stopped ? "Stopped" : expired ? "Expired" : {
    preparing: "Preparing", generating: "Model active", waiting: status.nextAttemptAt ? "Waiting" : "Window ending",
    sending: "Sending", stopped: "Stopped", expired: "Expired",
  }[status.phase]
  return {
    state, detail: stopped ? stoppedReason(status) : undefined, progress, hasWindow, dimmed: stopped || expired,
    completed: status.completed, failed: status.failed, timerWidth: remaining(status.durationMs).length,
    durationMs: status.durationMs, intervalMs: status.intervalMs,
    next: !stopped && !expired && status.phase === "waiting" && status.nextAttemptAt !== undefined && timers.showNextTimer !== false
      ? remaining(status.nextAttemptAt - now) : undefined,
    left: hasWindow && !stopped && !expired && timers.showRemainingTimer !== false ? remaining(status.expiresAt - now) : undefined,
  }
}

/** Fixed-width track with adjoining interval bands; dense windows group nominal slots. */
export function barCells(model: Pick<Indicator, "progress" | "durationMs" | "intervalMs">, width: number, maxSegments = Infinity): Cell[] {
  const count = Math.max(0, Math.min(256, Math.floor(width)))
  if (!count || model.durationMs <= 0 || model.intervalMs <= 0) return []
  const slots = Math.ceil(model.durationMs / model.intervalMs)
  const segments = Math.min(count, slots, maxSegments)
  const filled = Math.max(0, Math.min(1, model.progress)) * count
  const cells: Cell[] = []
  for (let segment = 0; segment < segments; segment++) {
    const position = segment / Math.max(1, segments - 1) * (colors.length - 1)
    const start = Math.floor(position)
    const fraction = position - start
    const color = "#" + [1, 3, 5].map((offset) => {
      const a = parseInt(colors[start].slice(offset, offset + 2), 16)
      const b = parseInt(colors[Math.min(start + 1, colors.length - 1)].slice(offset, offset + 2), 16)
      return Math.round(a + (b - a) * fraction).toString(16).padStart(2, "0")
    }).join("")
    // Preserve a shorter final interval, but give every visible band at least one column.
    const endSlot = Math.ceil((segment + 1) * slots / segments)
    const endTime = Math.min(model.durationMs, endSlot * model.intervalMs)
    const endColumn = Math.max(cells.length + 1,
      Math.min(count - (segments - segment - 1), Math.round(endTime / model.durationMs * count)))
    while (cells.length < endColumn) cells.push({ color, segment, fill: Math.max(0, Math.min(1, filled - cells.length)) })
  }
  return cells
}

/** All strings are ASCII; widths are terminal columns, including reserved timer space. */
export function compactLayout(model: Indicator, width: number, parent = false): CompactLayout {
  const budget = Math.max(0, Math.floor(width))
  const title = parent ? (budget >= 48 ? "Parent warming" : "Parent") : (budget >= 28 ? "Warming" : "Warm")
  const state = model.detail ? `${model.state}: ${model.detail}` : model.state
  const clippedTitle = title.slice(0, budget)
  const stateWidth = Math.max(0, budget - clippedTitle.length - 1 - (model.failed ? `${model.failed} failed`.length + 1 : 0))
  const clippedState = state.slice(0, Math.min(stateWidth, model.detail ? 26 : state.length))
  let used = clippedTitle.length + (clippedState ? clippedState.length + 1 : 0)
  const fields: CompactField[] = []
  const add = (text: string, reserved = text.length, warning = false) => {
    if (used + reserved + 1 > budget) return
    fields.push({ text, width: reserved, warning }); used += reserved + 1
  }
  if (model.failed) add(`${model.failed} failed`, undefined, true)
  if (model.completed !== undefined) add(`${model.completed} sent`)
  if (model.left) add(`${model.left} left`, model.timerWidth + 5)
  if (model.next) add(`next ${model.next}`, model.timerWidth + 5)
  const available = budget - used - 1
  const barWidth = model.hasWindow && available >= 6 ? Math.min(16, available) : 0
  return { title: clippedTitle, state: clippedState, fields, barWidth }
}
