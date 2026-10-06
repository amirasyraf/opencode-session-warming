import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate, setTimeout as sleep } from "node:timers/promises"
import { createDiagnostics, errorDetails, within } from "../diagnostics.ts"
import type { LogEntry } from "../diagnostics.ts"

test("levels, stable prefix and allowlisted fields make diagnostics useful without leaking request data", async () => {
  const entries: LogEntry[] = []
  const emit = createDiagnostics(async (entry) => { entries.push(entry) })
  emit({ event: "ready", intervalMs: 240000 })
  emit({ event: "warm-started", sessionID: "root" })
  emit({ event: "warm-failed", errorCode: "ENOTFOUND", body: "secret-prompt", authorization: "secret-token" })
  emit({ event: "disabled", reason: "invalid-interval" })
  await setImmediate()
  assert.deepEqual(entries.map((entry) => entry.level), ["info", "warn", "error"])
  assert.ok(entries.every((entry) => entry.message.startsWith("[session-warming]")))
  assert.equal(JSON.stringify(entries).includes("secret"), false)
  assert.equal(errorDetails(new Error("Bearer secret-token")).errorCategory, "unknown")
})

test("rejected SDK log responses degrade once and fallback is bounded", async () => {
  const fallback: LogEntry[] = []
  let calls = 0
  const emit = createDiagnostics(async () => { calls++; return { error: { message: "secret" } } },
    { fallback: async (entry) => { fallback.push(entry) } })
  emit({ event: "ready" })
  await setImmediate()
  for (let n = 0; n < 30; n++) emit({ event: "warm-failed", status: 503 })
  await setImmediate()
  assert.equal(calls, 1)
  assert.equal(fallback.filter((entry) => entry.extra.event === "logging-degraded").length, 1)
  assert.equal(fallback.length, 10)
  assert.equal(JSON.stringify(fallback).includes("secret"), false)
})

test("logging has a hard deadline, a concurrency bound, and never awaits the sink in a hook", async () => {
  let calls = 0
  const fallback: LogEntry[] = []
  const emit = createDiagnostics(async () => { calls++; return new Promise(() => {}) },
    { timeoutMs: 5, fallback: async (entry) => { fallback.push(entry) } })
  for (let n = 0; n < 100; n++) emit({ event: "ready" })
  await sleep(20)
  assert.equal(calls, 8)
  assert.equal(fallback.filter((entry) => entry.extra.event === "logging-degraded").length, 1)
  assert.equal(fallback[0].extra.errorCode, "logger-timeout")
  assert.ok(fallback.length <= 10)
})

test("bounded operations abort their signal even if the operation never settles", async () => {
  let signal: AbortSignal | undefined
  const request = within(async (value) => { signal = value; return new Promise(() => {}) }, 5, "metadata-timeout")
  const results = await Promise.all([assert.rejects(request, /metadata-timeout/), sleep(10)])
  assert.equal(results.length, 2)
  assert.equal(signal?.aborted, true)
})

test("debug is opt-in and fallback write failures cannot become unhandled errors", async () => {
  const entries: LogEntry[] = []
  const emit = createDiagnostics(async (entry) => { entries.push(entry) }, { debug: true })
  emit({ event: "scheduled", nextAttemptAt: 123 })
  await setImmediate()
  assert.equal(entries[0].level, "debug")
  const broken = createDiagnostics(async () => { throw new Error("secret") },
    { fallback: async () => { throw new Error("filesystem unavailable") } })
  broken({ event: "ready" })
  await setImmediate()
})
