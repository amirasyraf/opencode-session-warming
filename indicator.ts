import type { Mark, StatusRead, WarmStatus } from "./status.ts"

export type Cell = { glyph: string; color: string; count: number; fill: number }
export type Indicator = { cells: Cell[]; label: string; summary: string; compact: string; progress: number }
export type UiOptions = { enabled: boolean; color: boolean; maxSegments?: number; showNextTimer: boolean; showRemainingTimer: boolean }
const colors = ["#48c6e8", "#5fcaa2", "#9bcb7e", "#ffd166", "#f6a03d", "#e76a40", "#d93f3f"]

export function remaining(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return seconds >= 60 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : `${seconds}s`
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

function label(status: WarmStatus, now: number, showNextTimer: boolean): string {
  if (status.phase === "stopped") {
    if (status.reason?.startsWith("http-")) return `stopped: ${status.reason.slice(5)}`
    if (status.reason === "session-error") return "stopped: cancelled/error"
    if (status.reason === "ordinary-activity") return "reset by model activity"
    return `stopped: ${status.reason ?? "inactive"}`
  }
  if (status.phase === "expired" || now >= status.expiresAt) return "expired"
  if (status.phase === "preparing") return "preparing"
  if (status.phase === "generating") return "model active"
  if (status.phase === "sending") return "sending…"
  if (!showNextTimer) return "waiting"
  return status.nextAttemptAt ? `next ${remaining(status.nextAttemptAt - now)}` : "window ending"
}

/** Time-slot marks are separate from elapsed slots; skipped intervals never look like requests. */
export function indicator(read: StatusRead, now: number, width = 110, maxSegments = Infinity,
  timers: { showNextTimer?: boolean; showRemainingTimer?: boolean } = {}): Indicator {
  if (!read.status) {
    const text = read.unavailable ? `status unavailable: ${read.unavailable}` : "awaiting model activity"
    return { cells: [], label: text, summary: text, compact: text, progress: 0 }
  }
  const status = read.status
  if (status.expiresAt <= status.startedAt) {
    const state = label(status, now, timers.showNextTimer !== false)
    return { cells: [], label: state, summary: state, compact: state, progress: 0 }
  }
  const timeSlots = Math.max(1, Math.ceil(status.durationMs / status.intervalMs))
  const elapsed = Math.max(0, Math.min(now, status.stoppedAt ?? now) - status.startedAt)
  const progress = Math.min(1, elapsed / status.durationMs)
  const state = label(status, now, timers.showNextTimer !== false)
  const left = Math.max(0, status.expiresAt - now)
  const remainingTimer = timers.showRemainingTimer !== false && left && status.phase !== "stopped" ? ` · ${remaining(left)} left` : ""
  const compact = `${status.attempted} req · ${state}${remainingTimer}`
  const summary = `${status.attempted} req${status.failed ? ` · ${status.failed} failed` : ""} · ${state}${remainingTimer}`
  const count = Math.max(1, Math.min(timeSlots, maxSegments, Math.floor((width - (width < 70 ? compact : summary).length - 12) / 3)))
  const cells: Cell[] = Array.from({ length: count }, (_, index) => {
    const start = Math.ceil(index * timeSlots / count) * status.intervalMs
    const end = Math.min(status.durationMs, Math.ceil((index + 1) * timeSlots / count) * status.intervalMs)
    return { glyph: " ", fill: Math.max(0, Math.min(2, Math.floor((elapsed - start) / (end - start) * 2))),
      color: colors[Math.round(index / Math.max(1, count - 1) * (colors.length - 1))], count: 0 }
  })
  const groups: Mark[][] = Array.from({ length: count }, () => [])
  for (const mark of status.marks) {
    const slot = Math.max(0, Math.min(timeSlots - 1, Math.floor((mark.at - status.startedAt) / status.intervalMs) - 1))
    groups[Math.min(count - 1, Math.floor(slot * count / timeSlots))].push(mark)
  }
  for (const [index, marks] of groups.entries()) {
    if (!marks.length) continue
    cells[index].count = marks.length
    cells[index].glyph = marks.some((mark) => mark.result === "sending") ? (Math.floor(now / 500) % 2 ? "▸" : "▹") :
      marks.some((mark) => mark.result === "failed") ? "×" : marks.some((mark) => mark.result === "completed") ? "✓" : "–"
  }
  return {
    cells, label: state, compact, summary, progress,
  }
}
