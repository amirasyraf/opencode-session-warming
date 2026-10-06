import assert from "node:assert/strict"
import { test } from "node:test"
import { indicator, uiOptions } from "../indicator.ts"
import type { WarmStatus } from "../status.ts"

const base: WarmStatus = { sessionID: "root", phase: "waiting", startedAt: 0, expiresAt: 3600000,
  intervalMs: 240000, durationMs: 3600000, nextAttemptAt: 960000,
  attempted: 3, completed: 3, failed: 0, marks: [240010, 480010, 720010].map((at) => ({ at, result: "completed" })) }

test("default window dynamically has fifteen time slots with a cool-left/red-right palette", () => {
  const model = indicator({ status: base }, 720100)
  assert.equal(model.cells.length, 15)
  assert.deepEqual(model.cells.slice(0, 3).map((cell) => cell.glyph), ["✓", "✓", "✓"])
  assert.equal(model.cells[3].glyph, " ")
  assert.equal(model.cells[0].fill, 2)
  assert.equal(model.cells[0].color, "#48c6e8")
  assert.equal(model.cells.at(-1)!.color, "#d93f3f")
  assert.match(model.summary, /3 req.*next 4:00.*48:00 left/)
})

test("time-progress fill during generation never invents completed-request markers", () => {
  const model = indicator({ status: { ...base, phase: "generating", attempted: 0, completed: 0, marks: [] } }, 1200000)
  assert.ok(model.cells.some((cell) => cell.fill > 0))
  assert.ok(model.cells.every((cell) => cell.glyph === " " && cell.count === 0))
  assert.match(model.summary, /0 req.*model active/)
})

test("both countdowns default on and can be independently disabled", () => {
  assert.equal(uiOptions()?.showNextTimer, true)
  assert.equal(uiOptions()?.showRemainingTimer, true)
  assert.equal(uiOptions()?.maxSegments, undefined)
  assert.equal(uiOptions({ showNextTimer: "false" }), undefined)
  const noNext = indicator({ status: base }, 720100, 110, 14, { showNextTimer: false })
  assert.doesNotMatch(noNext.summary, /next /)
  assert.match(noNext.summary, /48:00 left/)
  const noRemaining = indicator({ status: base }, 720100, 110, 14, { showRemainingTimer: false })
  assert.match(noRemaining.summary, /next 4:00/)
  assert.doesNotMatch(noRemaining.summary, /left/)
  const noTimers = indicator({ status: base }, 720100, 110, 14, { showNextTimer: false, showRemainingTimer: false })
  assert.equal(noTimers.summary, "3 req · waiting")
})

test("segment count follows duration/interval, including a shorter final interval", () => {
  const tenMinutes = { ...base, expiresAt: 600000, durationMs: 600000, nextAttemptAt: undefined, marks: [] }
  assert.equal(indicator({ status: tenMinutes }, 0, 200).cells.length, 3)
  assert.equal(indicator({ status: tenMinutes }, 540000, 200).cells.at(-1)!.fill, 1)
  const twoMinutes = { ...base, intervalMs: 120000, marks: [] }
  assert.equal(indicator({ status: twoMinutes }, 0, 200).cells.length, 30)
  assert.ok(indicator({ status: twoMinutes }, 0, 60).cells.length < 30, "group only to fit the terminal")
  assert.equal(indicator({ status: twoMinutes }, 0, 200, 10).cells.length, 10, "an explicit user cap is optional")
})

test("native progress fill freezes on stop and never shows placeholder countdowns", () => {
  const stopped = { ...base, phase: "stopped" as const, stoppedAt: 720000, reason: "http-401" }
  assert.equal(indicator({ status: stopped }, 1500000).progress, 0.2)
  assert.equal(indicator({ status: stopped }, 3600000).progress, 0.2)
  assert.equal(indicator({ status: { ...base, phase: "generating", nextAttemptAt: undefined } }, 0).label, "model active")
  assert.equal(indicator({ status: { ...base, nextAttemptAt: undefined } }, 0).label, "window ending")
})

test("in-flight and failed markers remain distinguishable without colour", () => {
  const sending = { ...base, phase: "sending" as const, attempted: 4, marks: [...base.marks, { at: 960000, result: "sending" as const }] }
  const first = indicator({ status: sending }, 960000)
  const second = indicator({ status: sending }, 960500)
  assert.notEqual(first.cells[3].glyph, second.cells[3].glyph)
  assert.match(first.summary, /4 req.*sending/)
  const failed = indicator({ status: { ...sending, phase: "waiting", failed: 1,
    marks: [...base.marks, { at: 960000, result: "failed" }] } }, 960700)
  assert.equal(failed.cells[3].glyph, "×")
  assert.match(failed.summary, /1 failed/)
})

test("narrow and high-frequency windows group cells without changing request totals", () => {
  const model = indicator({ status: { ...base, intervalMs: 1, attempted: 10000 } }, 720000, 55, 14)
  assert.ok(model.cells.length <= 7)
  assert.match(model.summary, /10000 req/)
  assert.ok(indicator({ status: base }, 0, 20).cells.length <= 1)
})

test("stale, expired and unsupported states cannot masquerade as active warming", () => {
  assert.equal(indicator({ unavailable: "stale" }, 0).cells.length, 0)
  assert.match(indicator({ unavailable: "stale" }, 0).summary, /unavailable: stale/)
  assert.equal(indicator({ status: base }, 3600000).label, "expired")
  const stopped = indicator({ status: { ...base, phase: "stopped", reason: "http-401" } }, 960000)
  assert.equal(stopped.label, "stopped: 401")
  const unsupported = indicator({ status: { ...base, phase: "stopped", expiresAt: 0, reason: "unsupported-provider" } }, 0)
  assert.equal(unsupported.cells.length, 0)
  assert.match(unsupported.summary, /unsupported-provider/)
})
