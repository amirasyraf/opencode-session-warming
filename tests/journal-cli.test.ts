import assert from "node:assert/strict"
import { appendFile, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { test } from "node:test"
import { runJournalCLI } from "../journal-cli.ts"
import { readSegment, segmentFiles } from "../journal-reader.ts"
import { MAX_RECORD_BYTES, MAX_SEGMENT_BYTES, PLUGIN_VERSION, parseRecord } from "../journal-schema.ts"
import type { EventRecord, SegmentHeader } from "../journal-schema.ts"

const runID = "12345678-1234-4234-8234-123456789abc"
const otherRun = "87654321-4321-4321-8321-cba987654321"
const start = "2026-10-01T00:00:00.000Z"

function header(pid = process.pid, index = 0): SegmentHeader {
  const record = { schema: 1, recordKind: "segment", runID, pid, index, createdAt: start, pluginVersion: PLUGIN_VERSION }
  const parsed = parseRecord(record)
  assert.equal(parsed?.recordKind, "segment")
  return parsed as SegmentHeader
}

function event(seq: number, fields: Partial<EventRecord> = {}): EventRecord {
  const record = { schema: 1, recordKind: "event", runID, seq, eventID: `${runID}:${seq}`,
    recordedAt: start, runElapsedMs: seq, event: "ordinary.step-usage", providerID: "openai", modelID: "display-model",
    apiModelID: "api-model", sessionID: "session-a", projectID: "project-a", inputTokens: 10, ...fields }
  const parsed = parseRecord(record)
  assert.equal(parsed?.recordKind, "event")
  return parsed as EventRecord
}

function filename(pid = process.pid, index = 0, active = false): string {
  return `${runID}.${pid}.${index}.${active ? "open" : "1790812800000.jsonl"}`
}

const lines = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n") + "\n"

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = []
  for await (const result of source) results.push(result)
  return results
}

async function invoke(args: string[], directory: string) {
  const out: string[] = [], err: string[] = []
  const code = await runJournalCLI(args, { out: (line) => { out.push(line) }, err: (line) => { err.push(line) } }, directory)
  return { code, out, err }
}

test("validate counts records; export streams only events with exact metadata and UTC range filters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "warming-journal-cli-"))
  try {
    const selected = event(2, { recordedAt: "2026-10-02T12:00:00.123Z" })
    await writeFile(join(dir, filename()), lines(header(), event(1), selected,
      event(3, { recordedAt: "2026-10-03T00:00:00.000Z" }),
      event(4, { recordedAt: selected.recordedAt, providerID: "github-copilot" }),
      event(5, { recordedAt: selected.recordedAt, modelID: "different" }),
      event(6, { recordedAt: selected.recordedAt, apiModelID: "different" }),
      event(7, { recordedAt: selected.recordedAt, sessionID: "different" }),
      event(8, { recordedAt: selected.recordedAt, projectID: "different" })))
    const valid = await invoke(["validate"], dir)
    assert.equal(valid.code, 0)
    assert.deepEqual(JSON.parse(valid.out[0]!), { records: 9, segments: 1, issues: 0, warnings: 0, issueCodes: [] })
    assert.deepEqual(valid.err, [])
    const exported = await invoke(["export", "--directory", dir, "--from", "2026-10-02", "--to", "2026-10-03",
      "--provider", "openai", "--model", "display-model", "--api-model", "api-model", "--session", "session-a",
      "--run", runID, "--project", "project-a"], dir)
    assert.equal(exported.code, 0)
    assert.deepEqual(exported.out.map((line) => JSON.parse(line)), [selected])
    assert.equal(JSON.parse(exported.err[0]!).issues, 0)
    assert.equal(JSON.parse(exported.err[0]!).gaps, 0)
    const boundary = await invoke(["export", "--from", selected.recordedAt, "--to", "2026-10-02T12:00:01Z",
      "--project", "project-a", "--session", "session-a", "--api-model", "api-model", "--model", "display-model",
      "--provider", "openai"], dir)
    assert.deepEqual(boundary.out.map((line) => JSON.parse(line)), [selected])
    assert.equal((await invoke(["export", "--run", otherRun], dir)).out.length, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("CLI rejects bad arguments and normalized date rollovers before reading", async () => {
  const badArgs = [[], ["unknown"], ["validate", "--provider", "openai"], ["export", "--unknown", "x"],
    ["export", "--directory"], ["export", "--model", ""], ["export", "--from", "--to"],
    ["export", "--model", "x", "--model", "y"], ["validate", "--directory", "a", "--directory", "b"],
    ["export", "--from", "2026-02-31"], ["export", "--from", "2026-02-31T00:00:00Z"],
    ["export", "--from", "2026-10-01T24:00:00.000Z"], ["export", "--from", "2026-10-01T00:00:00+00:00"],
    ["export", "--from", "2026-10-03", "--to", "2026-10-02"],
    ["export", "--from", "2026-10-02", "--to", "2026-10-02"]]
  for (const args of badArgs) {
    const result = await invoke(args, join(tmpdir(), "unused-journal-test-directory"))
    assert.equal(result.code, 2, JSON.stringify(args))
    assert.deepEqual(result.out, [])
    assert.deepEqual(result.err, ["invalid-arguments"])
  }
})

test("corrupt and unknown schemas are skipped without exposing unvalidated fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "warming-journal-cli-"))
  try {
    const safe = event(3)
    const secret = "private prompt Bearer token raw error"
    await writeFile(join(dir, filename()), lines(header(), { ...event(1), prompt: secret },
      { ...event(2), schema: 99, error: secret }) + secret + "\n" + lines(safe))
    const result = await invoke(["export"], dir)
    assert.equal(result.code, 1)
    assert.deepEqual(result.out.map((line) => JSON.parse(line)), [safe])
    assert.equal(result.out.concat(result.err).join("\n").includes(secret), false)
    const summary = JSON.parse(result.err[0]!)
    assert.equal(summary.issues, 3)
    assert.equal(summary.warnings, 0)
    assert.deepEqual(summary.issueCodes.map((entry: { code: string }) => entry.code),
      ["invalid-record", "invalid-record", "invalid-json"])
    assert.equal(result.err.join("\n").includes(dir), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("reader validates headers, run identity and increasing sequences; gaps are warnings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "warming-journal-cli-"))
  try {
    const path = join(dir, filename())
    await writeFile(path, lines(header(), event(8), event(10), event(10), event(9),
      event(11, { runID: otherRun, eventID: `${otherRun}:11` }), header(), event(11)))
    const results = await collect(readSegment(path))
    assert.deepEqual(results.filter((result) => result.record).map((result) => result.record),
      [header(), event(8), event(10), event(11)])
    assert.deepEqual(results.flatMap((result) => result.issue ? [result.issue] : []),
      ["sequence-not-increasing", "sequence-not-increasing", "run-mismatch", "unexpected-header"])
    assert.deepEqual(results.flatMap((result) => result.warning ? [result.warning] : []), ["sequence-gap"])
    await writeFile(path, lines(header(), event(80), event(82)))
    const gap = await invoke(["validate"], dir)
    assert.equal(gap.code, 0)
    assert.equal(JSON.parse(gap.out[0]!).warnings, 1)
    assert.deepEqual(JSON.parse(gap.out[0]!).issueCodes, [])
    await writeFile(path, lines({ ...header(), index: 1 }, event(1)))
    assert.deepEqual((await collect(readSegment(path))).map((result) => result.issue),
      ["header-mismatch", "missing-header"])
    await writeFile(path, lines(event(1), event(2)))
    assert.deepEqual((await collect(readSegment(path))).map((result) => result.issue),
      ["missing-header", "missing-header"])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("a living PID partial line is pending; dead owners and closed partial lines are incomplete", async () => {
  const dir = await mkdtemp(join(tmpdir(), "warming-journal-cli-"))
  try {
    const active = join(dir, filename(process.pid, 0, true))
    await writeFile(active, lines(header()) + JSON.stringify(event(1)))
    assert.deepEqual(await collect(readSegment(active)), [{ record: header() }, { pending: true }])
    const pending = await invoke(["export"], dir)
    assert.equal(pending.code, 0)
    assert.deepEqual(pending.out, [])
    assert.equal(JSON.parse(pending.err[0]!).pending, 1)
    assert.equal(JSON.parse(pending.err[0]!).warnings, 1)
    const deadPID = 2147483647
    assert.throws(() => process.kill(deadPID, 0))
    const dead = join(dir, filename(deadPID, 0, true))
    await writeFile(dead, lines(header(deadPID)) + JSON.stringify(event(1)))
    assert.equal((await collect(readSegment(dead))).at(-1)?.issue, "incomplete-record")
    const closed = join(dir, filename(process.pid, 1))
    await writeFile(closed, lines(header(process.pid, 1)) + JSON.stringify(event(1)))
    assert.equal((await collect(readSegment(closed))).at(-1)?.issue, "incomplete-record")
    assert.equal((await invoke(["validate"], dir)).code, 1)
    await writeFile(closed, "")
    assert.deepEqual(await collect(readSegment(closed)), [{ issue: "missing-header" }])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("reader discards oversized lines once, across chunks, and enforces the segment size cap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "warming-journal-cli-"))
  try {
    const path = join(dir, filename())
    await writeFile(path, lines(header()) + "x".repeat(MAX_RECORD_BYTES + 2 * 64 * 1024) + "\n" + lines(event(1)))
    assert.deepEqual(await collect(readSegment(path)),
      [{ record: header() }, { issue: "record-too-large" }, { record: event(1) }])
    await writeFile(path, lines(header()) + "x".repeat(MAX_RECORD_BYTES + 1))
    assert.deepEqual(await collect(readSegment(path)), [{ record: header() }, { issue: "record-too-large" }])
    await writeFile(path, "x".repeat(MAX_SEGMENT_BYTES + 1))
    assert.deepEqual(await collect(readSegment(path)), [{ issue: "segment-too-large" }])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("reader captures opening size and releases its handle when consumption stops early", async () => {
  const dir = await mkdtemp(join(tmpdir(), "warming-journal-cli-"))
  try {
    const path = join(dir, filename(process.pid, 0, true))
    await writeFile(path, lines(header(), event(1)))
    const iterator = readSegment(path)
    assert.deepEqual((await iterator.next()).value, { record: header() })
    await appendFile(path, lines(event(2)))
    const remainder = []
    for await (const result of iterator) remainder.push(result)
    assert.deepEqual(remainder, [{ record: event(1) }])
    assert.equal((await collect(readSegment(path))).length, 3)
    const early = readSegment(path)
    await early.next()
    await early.return(undefined)
    assert.equal((await early.next()).done, true)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("enumeration ignores unrecognized names, symlinks and subdirectories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "warming-journal-cli-"))
  try {
    const path = join(dir, filename())
    await writeFile(path, lines(header(), event(1)))
    await writeFile(join(dir, "private-unrecognized.txt"), "private bytes")
    await writeFile(join(dir, `${runID}.0.0.open`), "invalid pid")
    await writeFile(join(dir, `${runID}.1.9007199254740992.open`), "invalid index")
    const linked = join(dir, filename(process.pid, 1, true))
    await symlink(path, linked)
    const nested = join(dir, filename(process.pid, 2, true))
    await mkdir(nested)
    await writeFile(join(nested, filename()), "never recurse")
    assert.deepEqual(await collect(segmentFiles(dir)), [path])
    assert.deepEqual(await collect(readSegment(linked)), [{ issue: "not-regular-file" }])
    assert.deepEqual(await collect(readSegment(nested)), [{ issue: "not-regular-file" }])
    assert.deepEqual(await collect(readSegment(join(dir, "private-unrecognized.txt"))), [{ issue: "invalid-filename" }])
    assert.equal((await invoke(["validate"], dir)).code, 0)
    assert.deepEqual(await collect(readSegment(join(dir, filename(process.pid, 3)))), [{ issue: "read-failed" }])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("missing default is empty; explicit missing and non-directory locations fail with exit 2", async () => {
  const dir = await mkdtemp(join(tmpdir(), "warming-journal-cli-"))
  try {
    const missing = join(dir, "missing")
    assert.deepEqual(await collect(segmentFiles(missing)), [])
    const empty = await invoke(["validate"], missing)
    assert.equal(empty.code, 0)
    assert.equal(JSON.parse(empty.out[0]!).records, 0)
    const exported = await invoke(["export"], missing)
    assert.equal(exported.code, 0)
    assert.deepEqual(exported.out, [])
    assert.equal(JSON.parse(exported.err[0]!).segments, 0)
    assert.equal((await invoke(["validate", "--directory", missing], dir)).code, 2)
    const file = join(dir, "not-directory")
    await writeFile(file, "private content")
    await assert.rejects(collect(segmentFiles(file)))
    assert.equal((await invoke(["export", "--directory", file], dir)).code, 2)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("diagnostic details stay bounded and both CLI commands leave journal bytes and mtime unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "warming-journal-cli-"))
  try {
    const path = join(dir, filename())
    const content = lines(header()) + "private invalid line\n".repeat(150) + lines(event(1))
    await writeFile(path, content)
    const before = await stat(path)
    const valid = await invoke(["validate"], dir)
    assert.equal(valid.code, 1)
    const summary = JSON.parse(valid.out[0]!)
    assert.equal(summary.issues, 150)
    assert.equal(summary.issueCodes.length, 100)
    assert.equal(summary.issueCodes[0].file, basename(path))
    assert.equal(JSON.stringify(summary).includes("private invalid line"), false)
    assert.equal((await invoke(["export"], dir)).code, 1)
    assert.equal(await readFile(path, "utf8"), content)
    assert.equal((await stat(path)).mtimeMs, before.mtimeMs)
    assert.deepEqual(await collect(segmentFiles(dir)), [path])
  } finally { await rm(dir, { recursive: true, force: true }) }
})
