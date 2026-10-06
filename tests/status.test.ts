import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readStatus, StatusPublisher } from "../status.ts"
import type { WarmStatus } from "../status.ts"

function state(sessionID = "root"): WarmStatus {
  const now = Date.now()
  return { sessionID, phase: "waiting", startedAt: now, expiresAt: now + 60000, intervalMs: 4000,
    durationMs: 60000, nextAttemptAt: now + 4000, attempted: 0, completed: 0, failed: 0, marks: [] }
}

test("metadata IPC is session-isolated, atomic, and never serializes extra request data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "warming-status-"))
  const writer = new StatusPublisher(() => {}, dir)
  try {
    writer.publish({ ...state("a"), body: "secret prompt", headers: "Bearer secret" } as WarmStatus)
    writer.publish({ ...state("b"), attempted: 3 })
    await writer.flush()
    assert.equal((await readStatus("a", dir)).status?.attempted, 0)
    assert.equal((await readStatus("b", dir)).status?.attempted, 3)
    const raw = await readFile(join(dir, "a.json"), "utf8")
    assert.equal(raw.includes("secret"), false)
    writer.publish({ ...state("a"), attempted: 1 })
    writer.publish({ ...state("a"), attempted: 2 })
    await writer.flush()
    assert.equal((await readStatus("a", dir)).status?.attempted, 2)
    assert.equal((await readStatus("../outside", dir)).unavailable, "invalid")
    assert.deepEqual(await readStatus("missing", dir), {})
  } finally { await writer.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test("reader rejects stale, oversized and invalid records; disposed owners leave no active status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "warming-status-"))
  const writer = new StatusPublisher(() => {}, dir)
  try {
    writer.publish(state())
    await writer.flush()
    assert.equal((await readStatus("root", dir, Date.now() + 16000)).unavailable, "stale")
    await writeFile(join(dir, "invalid.json"), "invalid JSON")
    assert.equal((await readStatus("invalid", dir)).unavailable, "invalid")
    await writeFile(join(dir, "huge.json"), "x".repeat(65537))
    assert.equal((await readStatus("huge", dir)).unavailable, "invalid")
    await writer.dispose()
    assert.deepEqual(await readStatus("root", dir), {})
    writer.publish(state())
    await writer.flush()
    assert.deepEqual(await readStatus("root", dir), {})
  } finally { await writer.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test("optional UI publication failures are reported without throwing into the engine", async () => {
  const dir = await mkdtemp(join(tmpdir(), "warming-status-"))
  const bad = join(dir, "not-a-directory")
  await writeFile(bad, "fixture")
  const logs: string[] = []
  const writer = new StatusPublisher((entry) => logs.push(entry.event), bad)
  try {
    writer.publish(state())
    await writer.flush()
    assert.deepEqual(logs, ["ui-status-failed"])
    writer.publish(state())
    await writer.flush()
    assert.equal(logs.length, 1)
  } finally { await writer.dispose(); await rm(dir, { recursive: true, force: true }) }
})
