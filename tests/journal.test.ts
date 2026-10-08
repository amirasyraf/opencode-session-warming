import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { test } from "node:test"
import { Journal, readPolicy, registerPolicy } from "../journal.ts"
import { readSegment, segmentFiles } from "../journal-reader.ts"
import { DAY_MS, parseRecord, PLUGIN_VERSION, safeData } from "../journal-schema.ts"
import type { EventRecord } from "../journal-schema.ts"
import { settings } from "../cache-policy.ts"

const options = { enabled: true, retentionDays: 365 }
async function records(root: string) {
  const events: EventRecord[] = []
  for await (const path of segmentFiles(join(root, "events"))) for await (const result of readSegment(path)) {
    assert.equal(result.issue, undefined)
    if (result.record?.recordKind === "event") events.push(result.record)
  }
  return events
}
async function fixture(root: string, at: number, damaged = false) {
  await mkdir(join(root, "events"), { recursive: true })
  const runID = randomUUID(), time = new Date(at).toISOString()
  const path = join(root, "events", `${runID}.${process.pid}.0.${at}.jsonl`)
  await writeFile(path, JSON.stringify({ schema: 1, recordKind: "segment", runID, pid: process.pid, index: 0,
    createdAt: time, pluginVersion: PLUGIN_VERSION }) + "\n" + JSON.stringify({ schema: 1, recordKind: "event", runID, seq: 1,
    eventID: `${runID}:1`, recordedAt: time, runElapsedMs: 1, event: "run.started" }) + (damaged ? "" : "\n"))
  return path
}

test("journal options are automatic, independent of debug, and invalid values disable the plugin", () => {
  assert.deepEqual(settings()?.journal, options)
  assert.equal(settings({ debug: false, journal: { enabled: false } })?.journal?.enabled, false)
  assert.equal(settings({ journal: { maxBytes: 8 * 1024 * 1024 } })?.journal?.maxBytes, 8 * 1024 * 1024)
  for (const journal of [false, [], { other: true }, { enabled: 1 }, { retentionDays: 0 }, { retentionDays: 1.5 },
    { retentionDays: Infinity }, { retentionDays: Number.MAX_SAFE_INTEGER }, { maxBytes: 1 }, { maxBytes: Infinity }])
    assert.equal(settings({ journal }), undefined)
})

test("the schema strips secrets and dynamic reason values; readers reject unsanitized records", async () => {
  const secret = "secret-prompt-token"
  const safe = safeData({ event: "warming.skipped", sessionID: "root", reason: `unsupported-input-${secret}`,
    headers: { authorization: secret }, prompt: secret, errorCode: secret, body: secret })!
  assert.deepEqual(safe, { event: "warming.skipped", sessionID: "root", reason: "unclassified" })
  assert.equal(parseRecord({ ...safe, schema: 2 }), undefined)
  assert.equal(PLUGIN_VERSION, JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version)
})

test("journal rotates private segments, preserves history on shutdown, and records safe metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "warming-journal-"))
  const journal = new Journal(options, () => {}, { directory: root, projectID: "project", segmentBytes: 2048 })
  try {
    for (let i = 0; i < 20; i++) journal.record({ event: "warm.completed", attemptID: `attempt-${i}`, inputTokens: 100,
      cachedTokens: 90, outputTokens: 1, prompt: "private content", authorization: "private token" })
    await journal.dispose()
    const names = await readdir(join(root, "events"))
    assert.ok(names.length > 1)
    assert.ok(names.every((name) => name.endsWith(".jsonl")))
    const data = await records(root)
    assert.equal(data.filter((record) => record.event === "warm.completed").length, 20)
    assert.equal(data.filter((record) => record.event === "run.ended").length, 1)
    assert.equal(JSON.stringify(data).includes("private"), false)
    assert.ok(data.every((record) => record.projectID === "project" && record.runID === journal.runID))
    for (const name of names) assert.equal((await stat(join(root, "events", name))).mode & 0o777, 0o600)
  } finally { await journal.dispose(); await rm(root, { recursive: true, force: true }) }
})

test("the newest startup controls retroactive retention while fresh and damaged history survives", async () => {
  const root = await mkdtemp(join(tmpdir(), "warming-journal-"))
  const old = await fixture(root, Date.now() - 10 * DAY_MS)
  const fresh = await fixture(root, Date.now())
  const damaged = await fixture(root, Date.now() - 10 * DAY_MS, true)
  const a = new Journal(options, () => {}, { directory: root })
  const b = new Journal({ ...options, retentionDays: 1 }, () => {}, { directory: root })
  try {
    await a.flush()
    assert.ok(await stat(old))
    await b.flush()
    assert.equal((await readPolicy(join(root, "policy")))?.retentionDays, 1)
    await assert.rejects(stat(old), { code: "ENOENT" })
    assert.ok(await stat(fresh)); assert.ok(await stat(damaged))
    await Promise.all([a.dispose(), b.dispose()])
    assert.equal((await readdir(join(root, "policy"))).filter((name) => name.endsWith(".reserve")).length, 2)
    assert.ok((await readdir(join(root, "events"))).some((name) => name.startsWith(a.runID)))
    assert.ok((await readdir(join(root, "events"))).some((name) => name.startsWith(b.runID)))
  } finally { await Promise.all([a.dispose(), b.dispose()]); await rm(root, { recursive: true, force: true }) }
})

test("startup order controls policy when an older instance flushes later", async () => {
  const root = await mkdtemp(join(tmpdir(), "warming-journal-order-"))
  const older = new Journal({ ...options, retentionDays: 1 }, () => {}, { directory: root, startedAt: 100 })
  const newer = new Journal(options, () => {}, { directory: root, startedAt: 200 })
  try {
    await newer.flush()
    await older.flush()
    const policy = await readPolicy(join(root, "policy"))
    assert.equal(policy?.retentionDays, 365)
    assert.equal(policy?.startedAt, 200)
  } finally { await Promise.all([older.dispose(), newer.dispose()]); await rm(root, { recursive: true, force: true }) }
})

test("exclusive reservations prevent delayed publications from replacing newer shared policy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "warming-policy-"))
  try {
    const first = randomUUID(), second = randomUUID()
    await Promise.all([registerPolicy(dir, first, options), registerPolicy(dir, second, { ...options, retentionDays: 30 })])
    const latest = await readPolicy(dir)
    assert.equal(latest?.generation, 2)
    await writeFile(join(dir, "1.json"), JSON.stringify({ schema: 1, generation: 1, runID: first, retentionDays: 1 }))
    assert.deepEqual(await readPolicy(dir), latest)
    await writeFile(join(dir, "3.reserve"), "")
    assert.deepEqual(await readPolicy(dir), latest)
    await writeFile(join(dir, "3.json"), JSON.stringify({ schema: 99, generation: 3 }))
    await assert.rejects(readPolicy(dir))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("recovering a timed-out older registration cannot shorten a newer startup's retention", async () => {
  const root = await mkdtemp(join(tmpdir(), "warming-policy-recovery-"))
  const retained = await fixture(root, Date.now() - 10 * DAY_MS)
  let release!: () => void, calls = 0
  const older = new Journal({ ...options, retentionDays: 1 }, () => {}, {
    directory: root, ioMs: 50, retryMs: 0,
    register: async (...args) => {
      await registerPolicy(...args)
      if (++calls === 1) await new Promise<void>((resolve) => { release = resolve })
    },
  })
  let newer: Journal | undefined
  try {
    const firstFlush = older.flush()
    while (!release) await sleep(1)
    await sleep(80)
    newer = new Journal(options, () => {}, { directory: root })
    await newer.flush()
    assert.equal((await readPolicy(join(root, "policy")))?.generation, 2)
    release(); await firstFlush
    await older.flush()
    const policy = await readPolicy(join(root, "policy"))
    assert.equal(policy?.generation, 2)
    assert.equal(policy?.retentionDays, 365)
    assert.ok(await stat(retained))
    assert.equal((await readdir(join(root, "policy"))).filter((name) => name.endsWith(".reserve")).length, 2)
  } finally { release?.(); await Promise.all([older.dispose(), newer?.dispose()]); await rm(root, { recursive: true, force: true }) }
})

test("a disk target pauses without deleting retained history, and recovery exposes gaps", async () => {
  const root = await mkdtemp(join(tmpdir(), "warming-pressure-"))
  const retained = await fixture(root, Date.now())
  const filler = join(root, "events", "foreign.bin")
  const file = await open(filler, "wx")
  await file.truncate(8 * 1024 * 1024); await file.close()
  const warnings: string[] = []
  const journal = new Journal({ ...options, maxBytes: 8 * 1024 * 1024 }, (entry) => warnings.push(String(entry.reason)), { directory: root, retryMs: 0 })
  try {
    await journal.flush()
    journal.record({ event: "warm.started", attemptID: "while-paused" })
    assert.ok(journal.counters.droppedPressure > 0)
    assert.ok(await stat(retained)); assert.ok(await stat(filler))
    await rm(filler)
    await journal.flush(); await journal.dispose()
    const data = await records(root)
    assert.ok(data.some((record) => record.event === "journal.health" && Number(record.droppedPressure) > 0 && record.reason === "pressure"))
    assert.deepEqual(warnings, ["pressure"])
  } finally { await journal.dispose(); await rm(root, { recursive: true, force: true }) }
})

test("queue admission stays bounded and shutdown reports dropped events", async () => {
  const root = await mkdtemp(join(tmpdir(), "warming-queue-"))
  const journal = new Journal(options, () => {}, { directory: root })
  try {
    for (let i = 0; i < 1200; i++) journal.record({ event: "warm.started", attemptID: `attempt-${i}` })
    assert.ok(journal.counters.droppedQueue > 0)
    assert.ok(journal.counters.admitted <= 1024)
    await journal.flush(); await journal.dispose()
    assert.ok((await records(root)).some((record) => record.event === "run.ended" && Number(record.droppedQueue) > 0))
  } finally { await journal.dispose(); await rm(root, { recursive: true, force: true }) }
})

test("timed-out writes remain owned until settlement and uncertain batches are not replayed", async () => {
  const root = await mkdtemp(join(tmpdir(), "warming-write-"))
  let release!: () => void, writes = 0
  const warnings: string[] = []
  const journal = new Journal(options, (entry) => warnings.push(String(entry.reason)), {
    directory: root, ioMs: 50, retryMs: 0,
    write: async (file, buffer) => {
      writes++
      if (writes === 1) await new Promise<void>((resolve) => { release = resolve })
      await file.writeFile(buffer)
    },
  })
  try {
    journal.record({ event: "warm.started", attemptID: "uncertain" })
    const flushing = journal.flush()
    while (!release) await sleep(1)
    await sleep(80)
    journal.record({ event: "warm.started", attemptID: "dropped-during-timeout" })
    assert.equal(writes, 1)
    assert.ok(journal.counters.droppedStorage > 0)
    release(); await flushing
    assert.ok(journal.counters.unconfirmedWrite > 0)
    await journal.flush(); await journal.dispose()
    const data = await records(root)
    assert.equal(data.some((record) => record.attemptID === "uncertain"), false)
    assert.ok(data.some((record) => record.event === "journal.health" && Number(record.unconfirmedWrite) > 0))
    assert.equal(warnings.filter((reason) => reason === "io-timeout").length, 1)
  } finally { release?.(); await journal.dispose(); await rm(root, { recursive: true, force: true }) }
})
