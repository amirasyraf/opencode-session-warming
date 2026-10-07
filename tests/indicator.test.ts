import assert from "node:assert/strict"
import { test } from "node:test"
import { barCells, compactLayout, indicator, remaining, uiOptions } from "../indicator.ts"
import type { WarmStatus } from "../status.ts"

const base: WarmStatus = { sessionID: "root", phase: "waiting", startedAt: 0, expiresAt: 3600000,
  intervalMs: 240000, durationMs: 3600000, nextAttemptAt: 960000,
  attempted: 3, completed: 3, failed: 0, marks: [240010, 480010, 720010].map((at) => ({ at, result: "completed" })) }

test("fixed-width track has adjoining interval colours and time-derived fractional fill", () => {
  const model = indicator({ status: base }, 720000)
  assert.equal(model.progress, 0.2)
  assert.equal(model.next, "04:00")
  assert.equal(model.left, "48:00")
  assert.equal(model.completed, 3)
  const cells = barCells(model, 37)
  assert.equal(cells.length, 37)
  assert.equal(cells[0].color, "#48c6e8")
  assert.equal(cells.at(-1)!.color, "#d93f3f")
  assert.equal(cells.filter((cell) => cell.fill === 1).length, 7)
  assert.ok(Math.abs(cells[7].fill - 0.4) < 1e-10)
  assert.ok(cells.slice(8).every((cell) => cell.fill === 0))
  assert.equal(new Set(cells.map((cell) => cell.segment)).size, 15)
  for (let segment = 0; segment < 15; segment++) {
    const band = cells.filter((cell) => cell.segment === segment)
    assert.ok(band.length >= 2)
    assert.equal(new Set(band.map((cell) => cell.color)).size, 1)
  }
  assert.deepEqual(barCells(indicator({ status: { ...base, attempted: 10000 } }, 720000), 37), cells)
})

test("fractional early fill, endpoints, and large widths remain bounded", () => {
  const model = indicator({ status: base }, 0)
  assert.ok(barCells(model, 30).every((cell) => cell.fill === 0))
  assert.equal(barCells({ ...model, progress: 0.001 }, 30)[0].fill, 0.03)
  assert.ok(barCells({ ...model, progress: 1 }, 30).every((cell) => cell.fill === 1))
  assert.ok(barCells({ ...model, progress: 2 }, 30).every((cell) => cell.fill === 1))
  assert.ok(barCells({ ...model, progress: -1 }, 30).every((cell) => cell.fill === 0))
  assert.equal(barCells(model, 100000).length, 256)
  assert.deepEqual(barCells(model, 0), [])
  const short = indicator({ status: { ...base, expiresAt: 600000, durationMs: 600000 } }, 540000)
  assert.equal(short.progress, 0.9)
})

test("duration/interval ratios change band counts, never track width or elapsed fill", () => {
  for (const [durationMs, intervalMs, expected] of [[900000, 180000, 5], [3600000, 240000, 15], [18000000, 1800000, 10]]) {
    const model = { progress: 0.3, durationMs, intervalMs }
    for (const width of [37, 60]) {
      const cells = barCells(model, width)
      assert.equal(cells.length, width)
      assert.equal(new Set(cells.map((cell) => cell.segment)).size, expected)
      assert.ok(Math.abs(cells.reduce((sum, cell) => sum + cell.fill, 0) - width * 0.3) < 1e-10)
    }
  }
})

test("short final intervals retain proportional space with a one-column minimum", () => {
  const cells = barCells({ progress: 0.9, durationMs: 600000, intervalMs: 240000 }, 30)
  assert.deepEqual([0, 1, 2].map((segment) => cells.filter((cell) => cell.segment === segment).length), [12, 12, 6])
  const tiny = barCells({ progress: 0, durationMs: 480001, intervalMs: 240000 }, 30)
  assert.equal(tiny.length, 30)
  assert.equal(tiny.at(-1)!.segment, 2)
  assert.equal(tiny.filter((cell) => cell.segment === 2).length, 1)
})

test("explicit caps and terminal grouping reduce bands without shortening the track", () => {
  const model = indicator({ status: base }, 720000)
  const capped = barCells(model, 37, 5)
  assert.equal(capped.length, 37)
  assert.equal(new Set(capped.map((cell) => cell.segment)).size, 5)
  assert.equal(barCells(model, 37, 1).length, 37)
  assert.equal(new Set(barCells(model, 37, 1).map((cell) => cell.color)).size, 1)
  const dense = barCells({ ...model, intervalMs: 1 }, 37)
  assert.equal(dense.length, 37)
  assert.equal(new Set(dense.map((cell) => cell.segment)).size, 37)
  assert.equal(dense[0].color, "#48c6e8")
  assert.equal(dense.at(-1)!.color, "#d93f3f")
  assert.deepEqual(barCells(indicator({}, 0), 37), [])
})

test("timers default on, remain independent, and state does not depend on timer visibility", () => {
  assert.equal(uiOptions()?.showNextTimer, true)
  assert.equal(uiOptions()?.showRemainingTimer, true)
  assert.equal(uiOptions()?.maxSegments, undefined)
  assert.equal(uiOptions({ showNextTimer: "false" }), undefined)
  assert.equal(uiOptions({ maxSegments: 0 }), undefined)
  const noNext = indicator({ status: base }, 720000, { showNextTimer: false })
  assert.equal(noNext.state, "Waiting")
  assert.equal(noNext.next, undefined)
  assert.equal(noNext.left, "48:00")
  const noLeft = indicator({ status: base }, 720000, { showRemainingTimer: false })
  assert.equal(noLeft.next, "04:00")
  assert.equal(noLeft.left, undefined)
  assert.equal(indicator({ status: base }, 720000, { showNextTimer: false, showRemainingTimer: false }).state, "Waiting")
})

test("duration formatting uses hours and fixed seconds with ceiling semantics", () => {
  assert.equal(remaining(0), "00:00")
  assert.equal(remaining(-1), "00:00")
  assert.equal(remaining(1), "00:01")
  assert.equal(remaining(59001), "01:00")
  assert.equal(remaining(3600000), "1:00:00")
  assert.equal(remaining((299 * 60 + 7) * 1000), "4:59:07")
  assert.equal(remaining(2147483647), "596:31:24")
})

test("stops freeze elapsed fill even after deadline, expiry is dimmed, and unavailable has no invented data", () => {
  const stopped = { ...base, phase: "stopped" as const, stoppedAt: 720000, reason: "http-401" }
  for (const now of [1500000, 3600000, 7200000]) {
    const model = indicator({ status: stopped }, now)
    assert.equal(model.progress, 0.2)
    assert.equal(model.state, "Stopped")
    assert.equal(model.detail, "HTTP 401")
    assert.equal(model.dimmed, true)
    assert.equal(model.next, undefined)
    assert.equal(model.left, undefined)
  }
  const expired = indicator({ status: base }, 3600000)
  assert.equal(expired.state, "Expired")
  assert.equal(expired.progress, 1)
  assert.equal(expired.dimmed, true)
  assert.equal(expired.left, undefined)
  for (const read of [{}, { unavailable: "stale" as const }, { unavailable: "invalid" as const }]) {
    const model = indicator(read, 0)
    assert.equal(model.hasWindow, false)
    assert.equal(model.completed, undefined)
    assert.equal(model.left, undefined)
  }
  const unsupported = indicator({ status: { ...stopped, expiresAt: 0, reason: "unsupported-provider" } }, 0)
  assert.equal(unsupported.hasWindow, false)
  assert.equal(unsupported.detail, "unsupported provider")
})

test("generation, preparation, sending, and end-of-window never show fake next countdowns", () => {
  for (const phase of ["generating", "preparing", "sending"] as const) {
    const model = indicator({ status: { ...base, phase } }, 1200000)
    assert.equal(model.next, undefined)
    assert.ok(model.progress > 0)
    assert.equal(model.completed, 3)
  }
  assert.equal(indicator({ status: { ...base, phase: "waiting", nextAttemptAt: undefined } }, 0).state, "Window ending")
  const sending = { ...base, phase: "sending" as const, attempted: 4 }
  const failed = { ...sending, phase: "waiting" as const, failed: 1 }
  assert.deepEqual(barCells(indicator({ status: sending }, 960000), 37), barCells(indicator({ status: failed }, 960000), 37))
})

test("completed totals use actual outcomes, not attempts, marks, or elapsed slots", () => {
  for (const phase of ["waiting", "sending", "stopped"] as const) {
    const model = indicator({ status: { ...base, phase, attempted: 10000, completed: 5, failed: 2, marks: [] } }, 900000)
    assert.equal(model.completed, 5)
    assert.equal(model.failed, 2)
    assert.ok(compactLayout(model, 100).fields.some((field) => field.text === "5 sent"))
    assert.ok(compactLayout(model, 100).fields.every((field) => !field.text.includes("10000")))
  }
  assert.equal(indicator({ status: { ...base, phase: "sending", attempted: 1, completed: 0 } }, 900000).completed, 0)
})

test("compact layouts fit their budget and protect failures before optional timers and bar", () => {
  const model = indicator({ status: { ...base, failed: 1 } }, 720000)
  for (const parent of [false, true]) {
    for (let width = 0; width <= 150; width++) {
      const layout = compactLayout(model, width, parent)
      const parts = [layout.title, layout.state, ...layout.fields.map((field) => field.text)].filter(Boolean)
      const used = layout.title.length + layout.state.length + layout.fields.reduce((total, field) => total + field.width, 0) + layout.barWidth
        + Math.max(0, parts.length + (layout.barWidth ? 1 : 0) - 1)
      assert.ok(used <= width, `${width}: ${JSON.stringify(layout)}`)
      if (width >= 24) assert.ok(layout.fields.some((field) => field.text === "1 failed"))
      if (width >= 48) assert.equal(layout.state, "Waiting")
    }
  }
  const wide = compactLayout(model, 110)
  assert.ok(wide.fields.some((field) => field.text.startsWith("next ")))
  assert.ok(wide.fields.some((field) => field.text.endsWith(" left")))
  assert.equal(wide.barWidth, 16)
})

test("timer boundaries preserve compact field widths and layout", () => {
  const before = compactLayout(indicator({ status: base }, 0), 90)
  const after = compactLayout(indicator({ status: base }, 1000), 90)
  assert.equal(before.barWidth, after.barWidth)
  assert.deepEqual(before.fields.map((field) => field.width), after.fields.map((field) => field.width))
  const stopped = compactLayout(indicator({ status: { ...base, phase: "stopped", reason: "clock-gap" } }, 720000), 55, true)
  assert.match(stopped.state, /Stopped: Resumed late/)
  assert.equal(stopped.title, "Parent warming")
})
