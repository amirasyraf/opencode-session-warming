import { once } from "node:events"
import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { readSegment, segmentFiles } from "./journal-reader.ts"
import { JournalReport, parseRates } from "./journal-report.ts"
import type { EventRecord } from "./journal-schema.ts"

type IO = { out(line: string): void | Promise<void>; err(line: string): void | Promise<void> }
const metadataFlags = {
  "--provider": "providerID", "--model": "modelID", "--api-model": "apiModelID",
  "--session": "sessionID", "--run": "runID", "--project": "projectID",
} as const
/** Counters that mean journal records were lost; exclusions and evictions are normal bounding, not loss. */
const lossCounters = ["droppedQueue", "droppedStorage", "droppedPressure", "droppedOversize", "unconfirmedWrite"]

function dateValue(value: string): number | undefined {
  let canonical: string
  if (/^\d{4}-\d\d-\d\d$/.test(value)) canonical = `${value}T00:00:00.000Z`
  else if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)) canonical = value.replace(/Z$/, ".000Z")
  else if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) canonical = value
  else return
  const time = Date.parse(canonical)
  if (Number.isFinite(time) && new Date(time).toISOString() === canonical) return time
}

function options(args: string[]) {
  const [command, ...rest] = args
  if (command !== "validate" && command !== "export" && command !== "report") return
  const flags = new Map<string, string>()
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i], value = rest[i + 1]
    if (!flag || !value || value.startsWith("--") || flags.has(flag) ||
      (flag !== "--directory" && (command === "validate" || (flag === "--rates" ? command !== "report" :
        flag !== "--from" && flag !== "--to" && !Object.hasOwn(metadataFlags, flag))))) return
    flags.set(flag, value)
  }
  const from = flags.has("--from") ? dateValue(flags.get("--from")!) : undefined
  const to = flags.has("--to") ? dateValue(flags.get("--to")!) : undefined
  if ((flags.has("--from") && from === undefined) || (flags.has("--to") && to === undefined) ||
    (from !== undefined && to !== undefined && from >= to)) return
  return { command, flags, from, to }
}

/** Read-only, streaming NDJSON export, structural validation, or an aggregate warming report. */
export async function runJournalCLI(args: string[], io: IO, defaultDirectory?: string): Promise<number> {
  const parsed = options(args)
  if (!parsed) { await io.err("invalid-arguments"); return 2 }
  const { command, flags, from, to } = parsed
  let report: JournalReport | undefined
  if (command === "report") {
    let rates
    if (flags.has("--rates")) {
      rates = await readFile(flags.get("--rates")!, "utf8").then((text) => parseRates(JSON.parse(text)), () => undefined)
      if (!rates) { await io.err("invalid-rates"); return 2 }
    }
    report = new JournalReport(rates)
  }
  const lossRuns = new Set<string>()
  const explicit = flags.has("--directory")
  const directory = flags.get("--directory") ?? defaultDirectory ??
    join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode", "session-warming", "events")
  const summary = { records: 0, segments: 0, issues: 0, warnings: 0,
    issueCodes: [] as { code: string; file: string }[] }
  let accessFailed = false, gaps = 0, pending = 0
  function detail(code: string, path: string) {
    if (summary.issueCodes.length < 100) summary.issueCodes.push({ code, file: basename(path) })
  }
  function matches(record: EventRecord): boolean {
    const time = Date.parse(record.recordedAt)
    if ((from !== undefined && time < from) || (to !== undefined && time >= to)) return false
    for (const [flag, key] of Object.entries(metadataFlags)) {
      if (flags.has(flag) && record[key] !== flags.get(flag)) return false
    }
    return true
  }
  try {
    let exists = true
    try {
      if (!(await stat(directory)).isDirectory()) throw new Error("not-directory")
    } catch (error) {
      if (!explicit && (error as NodeJS.ErrnoException).code === "ENOENT") exists = false
      else throw error
    }
    if (exists) {
      for await (const path of segmentFiles(directory)) {
        summary.segments++
        for await (const result of readSegment(path)) {
          if (result.issue) {
            summary.issues++
            detail(result.issue, path)
            if (result.issue === "read-failed" || result.issue === "not-regular-file") accessFailed = true
          }
          if (result.warning) {
            summary.warnings++
            if (result.warning === "sequence-gap") gaps++
          }
          if (result.pending) {
            summary.warnings++
            pending++
          }
          if (result.record) {
            const record = result.record
            summary.records++
            // Health counters are cumulative per run: a run that lost records is one warning, not one per heartbeat.
            if (record.recordKind === "event" && ["journal.health", "run.ended"].includes(record.event) &&
              lossCounters.some((key) => Number(record[key]) > 0)) lossRuns.add(record.runID)
            if (record.recordKind === "event" && matches(record)) {
              if (command === "export") await io.out(JSON.stringify(record))
              else report?.add(record)
            }
          }
        }
      }
    }
  } catch {
    accessFailed = true
    await io.err("journal-access-failed")
  }
  summary.warnings += lossRuns.size
  if (command === "validate") await io.out(JSON.stringify(summary))
  else {
    if (report && !accessFailed) await io.out(JSON.stringify(report.result(), null, 2))
    await io.err(JSON.stringify({ ...summary, gaps, pending, lossRuns: lossRuns.size }))
  }
  return accessFailed ? 2 : summary.issues ? 1 : 0
}

async function writeLine(stream: NodeJS.WriteStream, line: string): Promise<void> {
  if (!stream.write(`${line}\n`)) await once(stream, "drain")
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await runJournalCLI(process.argv.slice(2), {
      out: (line) => writeLine(process.stdout, line), err: (line) => writeLine(process.stderr, line),
    })
  } catch { process.exitCode = 2 }
}
