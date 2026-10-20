import assert from "node:assert/strict"
import { test } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"
import { StatusRegistry, safeStatus, wireStatus } from "../status.ts"
import type { WarmStatus } from "../status.ts"
import type { Diagnostic } from "../diagnostics.ts"

const status = (sessionID = "ses_1", extra: Record<string, unknown> = {}): WarmStatus => ({
  sessionID, phase: "waiting", startedAt: 1, expiresAt: 10_000, intervalMs: 100, durationMs: 9_999,
  attempted: 1, completed: 1, failed: 0, marks: [{ at: 2, result: "completed" }], providerID: "openai", model: "gpt-6.1-sol",
  ...extra,
} as WarmStatus)

test("status IPC reconstructs allowlisted metadata only", () => {
  const unsafe = { ...status(), headers: { authorization: "Bearer secret" }, snapshot: { input: "prompt" },
    reason: "Bearer secret value", model: "../../etc", usage: { inputTokens: 3, prompt: "x" } } as unknown as WarmStatus
  const safe = safeStatus(unsafe)!
  const text = JSON.stringify(wireStatus(safe))
  for (const leak of ["secret", "prompt", "etc", "headers", "snapshot"]) assert.equal(text.includes(leak), false, leak)
  assert.deepEqual(safe.usage, { inputTokens: 3 })
  for (const invalid of [{ ...status(), sessionID: "../x" }, { ...status(), phase: "bogus" }, { ...status(), marks: [{ at: -1, result: "completed" }] }]) {
    assert.equal(safeStatus(invalid), undefined)
  }
})

test("publication is coalesced, bounded, and emits the latest sanitized state per session", async () => {
  const emitted: WarmStatus[] = []
  const registry = new StatusRegistry(() => {}, async (value) => { emitted.push(value) })
  registry.publish(status("ses_1", { completed: 1 }))
  registry.publish(status("ses_1", { completed: 2 }))
  registry.publish(status("ses_2"))
  assert.equal(registry.get("ses_1")?.completed, 2)
  await sleep(300)
  assert.deepEqual(emitted.map((value) => [value.sessionID, value.completed]), [["ses_1", 2], ["ses_2", 1]])
  for (let index = 0; index < 70; index++) registry.publish(status(`ses_x${index}`))
  assert.equal(registry.get("ses_1"), undefined, "oldest sessions are evicted past the bound")
  registry.forget("ses_x69")
  assert.equal(registry.get("ses_x69"), undefined)
  registry.dispose()
  registry.publish(status("ses_after"))
  assert.equal(registry.get("ses_after"), undefined)
})

test("emit failures are reported once and never thrown into the engine", async () => {
  const logs: Diagnostic[] = []
  const registry = new StatusRegistry((value) => logs.push(value), async () => { throw new Error("rpc down") })
  registry.publish(status("ses_1"))
  registry.publish(status("ses_2"))
  await sleep(300)
  assert.deepEqual(logs.map((value) => [value.event, value.reason]), [["ui-status-failed", "publish-failed"]])
  registry.dispose()
})
