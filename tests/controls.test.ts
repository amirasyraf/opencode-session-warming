import assert from "node:assert/strict"
import { test } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"
import { ControlServer, controlRequest, parseWarmingArguments } from "../controls.ts"
import type { ControlRequest, ControlResult } from "../controls.ts"

const request = (sessionID = "root", action: "start" | "stop" = "stop", requestID = `req-${Math.random().toString(36).slice(2)}`) =>
  controlRequest({ requestID, sessionID, action })!

test("slash arguments map to the menu or one exact action; anything else is usage", () => {
  assert.equal(parseWarmingArguments(undefined), "menu")
  assert.equal(parseWarmingArguments("  "), "menu")
  assert.equal(parseWarmingArguments("start"), "start")
  assert.equal(parseWarmingArguments(" stop "), "stop")
  for (const value of ["restart", "start now", "stop!", "START"]) assert.equal(parseWarmingArguments(value), "invalid")
})

test("RPC control inputs accept only allowlisted metadata and receive a local deadline", () => {
  const now = 1_000
  assert.deepEqual(controlRequest({ requestID: "r1", sessionID: "ses_1", action: "start" }, now),
    { requestID: "r1", sessionID: "ses_1", action: "start", deadlineAt: now + 5000 })
  for (const value of [undefined, null, [], { requestID: "r1", sessionID: "ses_1", action: "pause" },
    { requestID: "r1", sessionID: "../x", action: "stop" }, { requestID: "r1", sessionID: "ses_1", action: "stop", prompt: "secret" },
    { requestID: "r".repeat(129), sessionID: "ses_1", action: "stop" }]) assert.equal(controlRequest(value, now), undefined)
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
