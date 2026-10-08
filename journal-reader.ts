import { constants } from "node:fs"
import { lstat, open, opendir } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { basename, join } from "node:path"
import { MAX_RECORD_BYTES, MAX_SEGMENT_BYTES, parseRecord } from "./journal-schema.ts"
import type { JournalRecord, SegmentHeader } from "./journal-schema.ts"

export type SegmentResult = { record?: JournalRecord; issue?: string; warning?: string; pending?: boolean }

// Closed segments carry an epoch-millisecond maximum timestamp, not an ISO date.
const filenamePattern = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([1-9]\d*)\.(0|[1-9]\d*)\.(open|(0|[1-9]\d*)\.jsonl)$/

function segmentName(name: string) {
  const match = filenamePattern.exec(name)
  if (!match) return
  const pid = Number(match[2]), index = Number(match[3])
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(index) ||
    (match[5] !== undefined && !Number.isSafeInteger(Number(match[5])))) return
  return { runID: match[1], pid, index, active: match[4] === "open" }
}

/** Enumeration is local and unsorted; no ordering between segments is implied. */
export async function* segmentFiles(directory: string): AsyncGenerator<string> {
  let entries
  try { entries = await opendir(directory) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  // The iterator closes its directory handle, including on early return.
  for await (const entry of entries) {
    if (entry.isFile() && segmentName(entry.name)) yield join(directory, entry.name)
  }
}

function living(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" }
}

/**
 * Read only the opening size, with fixed chunk/line buffers. Diagnostics never
 * contain file contents or exception text. Warnings do not establish corruption;
 * pending only means an unfinished .open line has a currently living PID.
 * Retention must reject any segment yielding an issue or pending result.
 */
export async function* readSegment(path: string): AsyncGenerator<SegmentResult> {
  const name = segmentName(basename(path))
  if (!name) { yield { issue: "invalid-filename" }; return }
  let handle: FileHandle | undefined
  try {
    if (!(await lstat(path)).isFile()) { yield { issue: "not-regular-file" }; return }
    // NONBLOCK also prevents a replacement FIFO from blocking before fstat.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = await handle.stat()
    if (!stat.isFile()) { yield { issue: "not-regular-file" }; return }
    const size = stat.size
    if (size > MAX_SEGMENT_BYTES) { yield { issue: "segment-too-large" }; return }

    let header: SegmentHeader | undefined
    let first = true, seq: number | undefined
    function lineResult(line: Buffer): SegmentResult {
      const isFirst = first
      first = false
      let value: unknown
      try { value = JSON.parse(line.toString("utf8")) }
      catch { return { issue: "invalid-json" } }
      const record = parseRecord(value)
      if (!record) return { issue: "invalid-record" }
      if (isFirst) {
        if (record.recordKind !== "segment") return { issue: "missing-header" }
        if (record.runID !== name!.runID || record.pid !== name!.pid || record.index !== name!.index)
          return { issue: "header-mismatch" }
        header = record
        return { record }
      }
      if (!header) return { issue: "missing-header" }
      if (record.recordKind !== "event") return { issue: "unexpected-header" }
      if (record.runID !== header.runID) return { issue: "run-mismatch" }
      if (seq !== undefined && record.seq <= seq) return { issue: "sequence-not-increasing" }
      const gap = seq !== undefined && record.seq !== seq + 1
      seq = record.seq
      return { record, ...(gap ? { warning: "sequence-gap" } : {}) }
    }

    const chunk = Buffer.alloc(64 * 1024), line = Buffer.alloc(MAX_RECORD_BYTES)
    let offset = 0, length = 0, discarding = false
    while (offset < size) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - offset), offset)
      if (!bytesRead) { yield { issue: "segment-truncated" }; return }
      offset += bytesRead
      let start = 0
      while (start < bytesRead) {
        const found = chunk.indexOf(10, start)
        const newline = found >= 0 && found < bytesRead ? found : -1
        const end = newline < 0 ? bytesRead : newline
        if (!discarding) {
          if (length + end - start + (newline < 0 ? 0 : 1) > MAX_RECORD_BYTES) {
            first = false
            length = 0
            discarding = true
            yield { issue: "record-too-large" }
          } else {
            chunk.copy(line, length, start, end)
            length += end - start
          }
        }
        if (newline < 0) break
        if (!discarding) yield lineResult(line.subarray(0, length))
        length = 0
        discarding = false
        start = newline + 1
      }
    }
    if (length || discarding || first) {
      if (name.active && living(name.pid)) yield { pending: true }
      else if (!discarding) yield { issue: first ? "missing-header" : "incomplete-record" }
    }
  } catch { yield { issue: "read-failed" } }
  finally { await handle?.close().catch(() => {}) }
}
