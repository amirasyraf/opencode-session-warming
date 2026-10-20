import assert from "node:assert/strict"
import { test } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"
import { ControlServer, controlRequest, parseDuration, parseWarmingArguments } from "../controls.ts"
import type { ControlRequest, ControlResult } from "../controls.ts"

const request = (sessionID = "root", action: "start" | "stop" = "stop", requestID = `req-${Math.random().toString(36).slice(2)}`) =>
  controlRequest({ requestID, sessionID, action })!

test("slash arguments map to the menu or one exact action; anything else is usage", () => {
  assert.equal(parseWarmingArguments(undefined), "menu")
  assert.equal(parseWarmingArguments("  "), "menu")
  assert.equal(parseWarmingArguments("start"), "start")
  assert.equal(parseWarmingArguments(" stop "), "stop")
  assert.deepEqual(parseWarmingArguments("extend"), { action: "extend" })
  assert.deepEqual(parseWarmingArguments(" extend 1h30m "), { action: "extend", durationMs: 5_400_000 })
  assert.deepEqual(parseWarmingArguments("extend\t30m"), { action: "extend", durationMs: 1_800_000 })
  for (const value of ["restart", "start now", "stop!", "START", "extend nope", "extend 1h 30m", "extend 1m1h",
    "extend 30m extra", "extend 0m", "extend 1.5h", "stop 30m"]) assert.equal(parseWarmingArguments(value), "invalid", value)
})

test("durations accept descending ASCII units within the safe timer limit", () => {
  assert.equal(parseDuration("30m"), 1_800_000)
  assert.equal(parseDuration("1h"), 3_600_000)
  assert.equal(parseDuration("1h30m"), 5_400_000)
  assert.equal(parseDuration("1d2h3m4s"), 93_784_000)
  for (const value of ["", "30", "m", "1h1h", "30m1h", "1h 30m", "-1h", "1H", "\u0661h", "25d", "99999999999999999999s"])
    assert.equal(parseDuration(value), undefined, value)
})

test("RPC control inputs accept only allowlisted metadata and receive a local deadline", () => {
  const now = 1_000
  assert.deepEqual(controlRequest({ requestID: "r1", sessionID: "ses_1", action: "start" }, now),
    { requestID: "r1", sessionID: "ses_1", action: "start", deadlineAt: now + 5000 })
  for (const value of [undefined, null, [], { requestID: "r1", sessionID: "ses_1", action: "pause" },
    { requestID: "r1", sessionID: "../x", action: "stop" }, { requestID: "r1", sessionID: "ses_1", action: "stop", prompt: "secret" },
    { requestID: "r".repeat(129), sessionID: "ses_1", action: "stop" },
    { requestID: "r1", sessionID: "ses_1", action: "start", durationMs: 30_000 },
    { requestID: "r1", sessionID: "ses_1", action: "extend", durationMs: 0 },
    { requestID: "r1", sessionID: "ses_1", action: "extend", durationMs: 1.5 },
    { requestID: "r1", sessionID: "ses_1", action: "extend", durationMs: 2 ** 31 },
    { requestID: "r1", sessionID: "ses_1", action: "extend", durationMs: "30m" }]) assert.equal(controlRequest(value, now), undefined)
  assert.deepEqual(controlRequest({ requestID: "r1", sessionID: "ses_1", action: "extend" }, now),
    { requestID: "r1", sessionID: "ses_1", action: "extend", deadlineAt: now + 5000 })
  assert.deepEqual(controlRequest({ requestID: "r1", sessionID: "ses_1", action: "extend", durationMs: 30_000 }, now),
    { requestID: "r1", sessionID: "ses_1", action: "extend", deadlineAt: now + 5000, durationMs: 30_000 })
})

test("duplicate request IDs apply once, and mismatched duplicates are rejected", async () => {
  let applied = 0
  const server = new ControlServer(async () => { applied++; await sleep(5); return "stopped" })
  const first = request("root", "stop", "same")
  const results = await Promise.all([server.receive(first), server.receive(first)])
  assert.deepEqual(results, ["stopped", "stopped"])
  assert.equal(await server.receive(first), "stopped")
  assert.equal(await server.receive({ ...first, action: "start" }), "busy")
  assert.equal(applied, 1)
  const extend = controlRequest({ requestID: "extend", sessionID: "root", action: "extend", durationMs: 30_000 })!
  assert.equal(await server.receive(extend), "stopped")
  assert.equal(await server.receive({ ...extend, durationMs: 60_000 }), "busy", "a duplicate with another duration is rejected")
  assert.equal(applied, 2)
})

test("actions are ordered per session while independent roots proceed", async () => {
  const order: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const server = new ControlServer(async (value: ControlRequest) => {
    order.push(`${value.sessionID}:${value.action}:start`)
    if (value.sessionID === "a" && value.action === "stop") await gate
    order.push(`${value.sessionID}:${value.action}:end`)
    return value.action === "stop" ? "stopped" : "started"
  })
  const a1 = server.receive(request("a", "stop"))
  const a2 = server.receive(request("a", "start"))
  assert.equal(await server.receive(request("b", "start")), "started")
  release()
  assert.deepEqual(await Promise.all([a1, a2]), ["stopped", "started"])
  assert.deepEqual(order, ["a:stop:start", "b:start:start", "b:start:end", "a:stop:end", "a:start:start", "a:start:end"])
})

test("deletion and disposal fence continuations; expired deadlines never mutate", async () => {
  let mutated = 0
  const server = new ControlServer(async (_value, current) => {
    await sleep(10)
    if (!current()) return "expired"
    mutated++
    return "stopped"
  })
  const pending = server.receive(request("gone"))
  server.cancel("gone")
  assert.equal(await pending, "expired")
  const late = { ...request("late"), deadlineAt: Date.now() - 1 }
  assert.equal(await server.receive(late), "expired")
  server.dispose()
  assert.equal(await server.receive(request("after")), "unavailable")
  assert.equal(mutated, 0)
})

test("metadata failures report unavailable and pressure limits reject excess work", async () => {
  const failing = new ControlServer(async () => { throw new Error("lookup failed") })
  assert.equal(await failing.receive(request()), "unavailable")
  const results: Promise<ControlResult>[] = []
  const slow = new ControlServer(async () => { await sleep(20); return "stopped" })
  for (let index = 0; index < 40; index++) results.push(slow.receive(request(`s${index}`)))
  const settled = await Promise.all(results)
  assert.ok(settled.includes("busy"))
  assert.ok(settled.filter((value) => value === "stopped").length >= 32)
})
