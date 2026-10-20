import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Journal } from "../journal.ts"
import { OrdinaryObserver } from "../ordinary-observer.ts"
import { readSegment, segmentFiles } from "../journal-reader.ts"
import type { EventRecord } from "../journal-schema.ts"
import type { UsageStats } from "../status.ts"

const started = (id = "msg_a", fields: Record<string, unknown> = {}) => ({ type: "session.step.started", data: {
  sessionID: "root", assistantMessageID: id, agent: "build", model: { providerID: "openai", id: "alias", variant: "default" }, started: Date.now(), ...fields } })
const ended = (id = "msg_a", fields: Record<string, unknown> = {}) => ({ type: "session.step.ended", data: {
  sessionID: "root", assistantMessageID: id, finish: "stop", cost: 0.25, tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 90, write: 5 } },
  native: { secret: "prompt text" }, files: ["private/path.ts"], ...fields } })
const call = { sessionID: "root", providerID: "openai", modelID: "alias", apiModelID: "native-model", at: Date.now() - 1000 }

async function harness(onUsage?: (sessionID: string, usage: UsageStats) => void) {
  const directory = await mkdtemp(join(tmpdir(), "warming-observer-"))
  const journal = new Journal({ enabled: true, retentionDays: 365 }, () => {}, { directory })
  const observer = new OrdinaryObserver(journal, onUsage)
  return { journal, observer, async finish() {
    observer.dispose(); await journal.dispose()
    const data: EventRecord[] = []
    for await (const path of segmentFiles(join(directory, "events"))) for await (const result of readSegment(path)) {
      assert.equal(result.issue, undefined)
      if (result.record?.recordKind === "event") data.push(result.record)
    }
    await rm(directory, { recursive: true, force: true })
    return data
  } }
}

test("root steps are attributed to their ordinary call and report normalized usage once", async () => {
  const usage: [string, UsageStats][] = []
  const h = await harness((id, value) => usage.push([id, value]))
  h.observer.classify("root", true)
  const id = h.observer.call(call, "2.1.0")
  h.observer.event(started())
  h.observer.event(ended())
  h.observer.event(ended())
  const records = await h.finish()
  const step = records.find((record) => record.event === "ordinary.step-usage")!
  assert.equal(step.ordinaryCallID, id)
  assert.equal(step.apiModelID, "native-model")
  assert.equal(step.cacheReadTokens, 90)
  assert.equal(records.filter((record) => record.event === "ordinary.step-usage").length, 1)
  assert.deepEqual(usage, [["root", { uncachedInputTokens: 10, cachedTokens: 90, cacheWriteTokens: 5, outputTokens: 5 }]])
  const text = JSON.stringify(records)
  for (const leak of ["prompt text", "private/path"]) assert.equal(text.includes(leak), false)
})

test("children, unsupported providers, auxiliary agents and unknown roots are excluded", async () => {
  const usage: string[] = []
  const h = await harness((id) => usage.push(id))
  h.observer.classify("child", false)
  h.observer.classify("root", true)
  h.observer.event(started("msg_child", { sessionID: "child" }))
  h.observer.event(ended("msg_child", { sessionID: "child" }))
  h.observer.event(started("msg_other", { model: { providerID: "anthropic", id: "claude" } }))
  h.observer.event(ended("msg_other"))
  h.observer.event(started("msg_unknown", { sessionID: "nobody" }))
  h.observer.event(ended("msg_unknown", { sessionID: "nobody" }))
  h.observer.event({ type: "session.step.ended", data: { sessionID: "root" } })
  const records = await h.finish()
  assert.equal(records.some((record) => String(record.event).startsWith("ordinary.step")), false)
  assert.deepEqual(usage, [])
})

test("ambiguous calls are not guessed, and failed steps record an outcome", async () => {
  const h = await harness()
  h.observer.classify("root", true)
  h.observer.call(call, "2.1.0")
  h.observer.call({ ...call, at: call.at + 5 }, "2.1.0")
  h.observer.event(started())
  h.observer.event({ type: "session.step.failed", data: { sessionID: "root", assistantMessageID: "msg_a", error: { type: "provider.auth", message: "no" } } })
  const records = await h.finish()
  const outcome = records.find((record) => record.event === "ordinary.message-completed")!
  assert.equal(outcome.ordinaryCallID, undefined)
  assert.equal(outcome.errorCategory, "auth")
  assert.equal(outcome.finish, "error")
})

test("usage still reaches the engine without a journal; deletion forgets session metadata", async () => {
  const usage: string[] = []
  const observer = new OrdinaryObserver(undefined, (id) => usage.push(id))
  observer.classify("root", true)
  observer.call(call, "2.1.0")
  observer.event(started())
  observer.event(ended())
  observer.event({ type: "session.deleted", data: { sessionID: "root" } })
  observer.event(started("msg_b"))
  observer.event(ended("msg_b"))
  observer.dispose()
  assert.deepEqual(usage, ["root"])
})
