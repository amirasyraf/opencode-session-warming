import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { Event } from "@opencode-ai/sdk"
import { Journal } from "../journal.ts"
import { OrdinaryObserver } from "../ordinary-observer.ts"
import { readSegment, segmentFiles } from "../journal-reader.ts"
import type { EventRecord } from "../journal-schema.ts"
import type { UsageStats } from "../status.ts"

function message(id = "assistant", fields: Record<string, unknown> = {}): Event {
  return { type: "message.updated", properties: { info: { id, sessionID: "root", role: "assistant", parentID: "user",
    providerID: "openai", modelID: "alias", mode: "build", time: { created: 10 }, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    path: { cwd: "private-path", root: "private-root" }, cost: 999, ...fields } } } as Event
}
function step(id = "step", messageID = "assistant", fields: Record<string, unknown> = {}): Event {
  return { type: "message.part.updated", properties: { part: { type: "step-finish", id, sessionID: "root", messageID,
    reason: "stop", cost: 0.25, tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 90, write: 5 } }, ...fields } } } as Event
}
const call = { sessionID: "root", userMessageID: "user", providerID: "openai", modelID: "alias", apiModelID: "native-model", at: 20 }

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

test("step accounting survives warming absence, deduplicates snapshots, and retains amended outcomes", async () => {
  const live: UsageStats[] = []
  const h = await harness((_sessionID, usage) => live.push(usage))
  h.observer.classify("root", true)
  h.observer.event(message())
  const id = h.observer.call(call, "1.18.35")
  h.observer.event(step()); h.observer.event(step())
  h.observer.event(step("step", "assistant", { cost: 0.5 }))
  h.observer.event(message("assistant", { time: { created: 10, completed: 30 }, finish: "stop" }))
  h.observer.event(message("assistant", { time: { created: 10, completed: 30 }, finish: "stop" }))
  h.observer.event(message("assistant", { time: { created: 10, completed: 30 }, error: { name: "UnknownError", data: { message: "secret-error" } } }))
  const data = await h.finish()
  const usage = data.filter((entry) => entry.event === "ordinary.step-usage")
  assert.equal(usage.length, 2)
  assert.ok(usage.every((entry) => entry.ordinaryCallID === id && entry.modelID === "alias" && entry.apiModelID === "native-model"))
  assert.deepEqual(usage.map((entry) => entry.reportedCost), [0.25, 0.5])
  assert.equal(usage[0]!.uncachedInputTokens, 10); assert.equal(usage[0]!.cacheReadTokens, 90)
  assert.equal(usage[0]!.nonReasoningOutputTokens, 2); assert.equal(usage[0]!.reasoningTokens, 3)
  assert.equal(usage[0]!.costUnit, "unspecified")
  assert.deepEqual(live, [{ uncachedInputTokens: 10, cachedTokens: 90, cacheWriteTokens: 5, outputTokens: 5 }])
  assert.equal(data.filter((entry) => entry.event === "ordinary.message-completed").length, 2)
  assert.equal(JSON.stringify(data).includes("secret"), false); assert.equal(JSON.stringify(data).includes("private"), false)
  assert.equal(data.some((entry) => entry.reportedCost === 999), false)
})

test("forked history, synthetic assistants after old calls, internal activity, children and unknown roots are excluded", async () => {
  const h = await harness()
  h.observer.classify("root", true)
  h.observer.call(call, "1.18.35")
  h.observer.event(message("fork", { time: { created: 1, completed: 5 } })); h.observer.event(step("fork-step", "fork"))
  h.observer.event(message("synthetic", { time: { created: 21, completed: 30 } })); h.observer.event(step("shell-step", "synthetic"))
  h.observer.event(message("summary", { summary: true })); h.observer.event(step("summary-step", "summary"))
  h.observer.classify("child", false)
  h.observer.event(message("child-assistant", { sessionID: "child" })); h.observer.event(step("child-step", "child-assistant", { sessionID: "child" }))
  h.observer.event(message("unknown-assistant", { sessionID: "unknown" })); h.observer.event(step("unknown-step", "unknown-assistant", { sessionID: "unknown" }))
  const data = await h.finish()
  assert.equal(data.some((entry) => entry.event === "ordinary.step-usage" || entry.event === "ordinary.message-completed"), false)
  assert.ok(h.journal.counters.excludedMetadata > 0)
})

test("reordered metadata resolves from existing events, and ambiguous calls are not guessed", async () => {
  const h = await harness()
  h.observer.event(step())
  h.observer.event(message())
  h.observer.classify("root", true)
  h.observer.call(call, "1.18.35")
  h.observer.call({ ...call, at: 21 }, "1.18.35")
  h.observer.event(step("next-step"))
  const data = await h.finish()
  const usage = data.filter((entry) => entry.event === "ordinary.step-usage")
  assert.equal(usage.length, 2)
  assert.ok(usage[0]!.ordinaryCallID)
  assert.equal(usage[1]!.ordinaryCallID, undefined)
  assert.ok(h.journal.counters.unattributed > 0)
})

test("pending metadata and source caches are bounded and exclusions are accounted", async () => {
  const h = await harness()
  for (let i = 0; i < 200; i++) h.observer.event(step(`pending-${i}`, `missing-${i}`))
  assert.ok(h.journal.counters.excludedMetadata >= 72)
  for (let i = 0; i < 1100; i++) h.observer.classify(`root-${i}`, true)
  assert.ok(h.journal.counters.evictedMetadata >= 76)
  await h.finish()
  assert.ok(h.journal.counters.excludedMetadata >= 200)
})
