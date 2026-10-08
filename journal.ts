import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { mkdir, open, opendir, rename, stat, unlink } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { setImmediate as yieldTurn } from "node:timers/promises"
import { readSegment, segmentFiles } from "./journal-reader.ts"
import { count, DAY_MS, diagnosticEvents, identifier, MAX_RECORD_BYTES, MAX_SEGMENT_BYTES, object, PLUGIN_VERSION, safeData } from "./journal-schema.ts"
import type { EventRecord, JournalData, JournalOptions, SegmentHeader } from "./journal-schema.ts"
import type { Diagnostic } from "./diagnostics.ts"

export const journalDirectory = () => join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode", "session-warming")
type Policy = { schema: 1; generation: number; runID: string; startedAt?: number; retentionDays: number; maxBytes?: number }
export type PolicyRegistration = { generation?: number; published?: boolean; startedAt?: number }
const policyName = /^([1-9]\d*)\.(json|reserve)$/
const code = (error: unknown) => object(error) ? error.code : undefined

async function generations(directory: string) {
  let maximum = 0, entries = 0
  const published: number[] = []
  for await (const entry of await opendir(directory)) {
    const match = policyName.exec(entry.name)
    if (!match) continue
    if (!entry.isFile()) throw new Error("policy-unavailable")
    const n = Number(match[1])
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error("policy-unavailable")
    maximum = Math.max(maximum, n)
    if (match[2] === "json") published.push(n)
    if (++entries % 256 === 0) await yieldTurn()
  }
  return { maximum, published }
}

function newerPolicy(candidate: Policy, current: Policy): boolean {
  return (candidate.startedAt ?? 0) > (current.startedAt ?? 0) ||
    (candidate.startedAt ?? 0) === (current.startedAt ?? 0) && candidate.generation > current.generation
}

async function policySet(directory: string) {
  const { published } = await generations(directory)
  const valid: Policy[] = []
  let invalidGeneration = 0
  for (const generation of published) {
    try { valid.push(await readPolicyFile(directory, generation)) }
    catch { invalidGeneration = Math.max(invalidGeneration, generation) }
  }
  return { valid, invalidGeneration }
}

function effectivePolicy(valid: Policy[], invalidGeneration: number): Policy | undefined {
  let latest: Policy | undefined
  for (const policy of valid) if (!latest || newerPolicy(policy, latest)) latest = policy
  if (invalidGeneration > (latest?.generation ?? 0)) throw new Error("policy-unavailable")
  return latest
}

export async function readPolicy(directory: string): Promise<Policy | undefined> {
  const policies = await policySet(directory)
  return effectivePolicy(policies.valid, policies.invalidGeneration)
}

async function readPolicyFile(directory: string, published: number): Promise<Policy> {
  const file = await open(join(directory, `${published}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > MAX_RECORD_BYTES) throw new Error("policy-unavailable")
    const value: unknown = JSON.parse(await file.readFile("utf8"))
    if (!object(value) || value.schema !== 1 || value.generation !== published || !identifier(value.runID) ||
      (value.startedAt !== undefined && (!count(value.startedAt) || !value.startedAt)) ||
      !count(value.retentionDays) || !value.retentionDays || !Number.isSafeInteger(value.retentionDays * DAY_MS) ||
      value.retentionDays * DAY_MS > 8_640_000_000_000_000 ||
      (value.maxBytes !== undefined && (!count(value.maxBytes) || value.maxBytes < 8 * 1024 * 1024)) ||
      Object.keys(value).some((key) => !["schema", "generation", "runID", "startedAt", "retentionDays", "maxBytes"].includes(key))) throw new Error("policy-unavailable")
    return value as Policy
  } finally { await file.close() }
}

/** Empty reservations are permanent: a stalled allocator must never reuse a generation. */
export async function registerPolicy(directory: string, runID: string, options: JournalOptions, active = () => true,
  registration: PolicyRegistration = {}): Promise<void> {
  // Recovery is not a new startup. A late publication or transient failure must
  // never allocate a newer generation and replace another startup's policy.
  if (registration.published) return
  registration.startedAt ??= Date.now()
  if (registration.generation === undefined) {
    let candidate = (await generations(directory)).maximum
    for (;;) {
      if (!active()) throw new Error("storage-error")
      if (!Number.isSafeInteger(++candidate)) throw new Error("policy-unavailable")
      try {
        const reservation = await open(join(directory, `${candidate}.reserve`), "wx", 0o600)
        registration.generation = candidate
        await reservation.close()
        break
      } catch (error) { if (code(error) !== "EEXIST") throw error }
    }
  }
  const generation = registration.generation
  const value: Policy = { schema: 1, generation, runID, startedAt: registration.startedAt, retentionDays: options.retentionDays,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }) }
  const temporary = join(directory, `${generation}.${runID}.tmp`)
  if (!active()) throw new Error("storage-error")
  const file = await open(temporary, "wx", 0o600)
  try {
    if (!active()) throw new Error("storage-error")
    await file.writeFile(JSON.stringify(value)); await file.close()
    if (!active()) throw new Error("storage-error")
    await rename(temporary, join(directory, `${generation}.json`))
    registration.published = true
  }
  finally { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}) }
  const policies = await policySet(directory)
  const latest = effectivePolicy(policies.valid, policies.invalidGeneration)
  for (const policy of policies.valid) {
    if (!latest || policy.generation === latest.generation || !active()) continue
    // Unrecognized/damaged policies remain available for inspection.
    await unlink(join(directory, `${policy.generation}.json`)).catch((error: unknown) => { if (code(error) !== "ENOENT") throw error })
  }
}

export class Journal {
  readonly runID = randomUUID()
  readonly counters = { offered: 0, admitted: 0, droppedQueue: 0, droppedStorage: 0, droppedPressure: 0,
    droppedOversize: 0, unconfirmedWrite: 0, excludedMetadata: 0, evictedMetadata: 0, unattributed: 0 }
  private root: string
  private options: JournalOptions
  private projectID?: string
  private warn: (diagnostic: Diagnostic) => void
  private queue: Buffer[] = []
  private bytes = 0
  private inFlight = 0
  private seq = 0
  private origin = performance.now()
  private work?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private heartbeat?: ReturnType<typeof setInterval>
  private closed = false
  private closing = false
  private initialized = false
  private policy?: Policy
  private paused?: "storage-error" | "io-timeout" | "pressure" | "policy-unavailable"
  private pauseStartedAt?: number
  private retryAt = 0
  private scannedAt = 0
  private estimatedBytes = 0
  private cleanupAt = 0
  private cleanup?: AsyncGenerator<string>
  private file?: FileHandle
  private filePath?: string
  private fileBytes = 0
  private fileMaxAt = 0
  private fileDate = ""
  private index = 0
  private startupOnly: boolean
  private registration: PolicyRegistration = {}
  private register: typeof registerPolicy
  private limits: { flushMs: number; ioMs: number; retryMs: number; segmentBytes: number }
  private write: (file: FileHandle, buffer: Buffer) => Promise<void>

  constructor(options: JournalOptions, warn: (diagnostic: Diagnostic) => void, context: {
    directory?: string; projectID?: string; startupOnly?: boolean; startedAt?: number
    flushMs?: number; ioMs?: number; retryMs?: number; segmentBytes?: number
    write?: (file: FileHandle, buffer: Buffer) => Promise<void>
    register?: typeof registerPolicy
  } = {}) {
    this.options = options; this.warn = warn; this.root = context.directory ?? journalDirectory()
    this.projectID = identifier(context.projectID) ? context.projectID : undefined
    this.startupOnly = context.startupOnly ?? false
    this.register = context.register ?? registerPolicy
    this.registration = { startedAt: context.startedAt ?? Date.now() }
    this.limits = { flushMs: context.flushMs ?? 1000, ioMs: context.ioMs ?? 2000, retryMs: context.retryMs ?? 30_000,
      segmentBytes: Math.min(context.segmentBytes ?? MAX_SEGMENT_BYTES, MAX_SEGMENT_BYTES) }
    this.write = context.write ?? (async (file, buffer) => {
      let offset = 0
      while (offset < buffer.length) {
        const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset)
        if (!bytesWritten) throw new Error("storage-error")
        offset += bytesWritten
      }
    })
    this.record({ event: "run.started", pluginVersion: PLUGIN_VERSION, version: "1.18.x",
      retentionDays: options.retentionDays, maxBytes: options.maxBytes })
    if (!this.startupOnly) {
      this.heartbeat = setInterval(() => { this.health(); this.drain() }, 30_000)
      this.heartbeat.unref()
    }
  }

  record(value: unknown): void {
    if (this.closed || this.closing) return
    this.counters.offered++
    const seq = ++this.seq, data = safeData(value)
    if (!data) { this.counters.excludedMetadata++; return }
    if (this.paused) {
      if (this.paused === "pressure") this.counters.droppedPressure++
      else this.counters.droppedStorage++
      return
    }
    const record: EventRecord = { ...data, schema: 1, recordKind: "event", runID: this.runID, seq,
      eventID: `${this.runID}:${seq}`, recordedAt: new Date().toISOString(), runElapsedMs: performance.now() - this.origin,
      ...(this.projectID === undefined ? {} : { projectID: this.projectID }) }
    const buffer = Buffer.from(JSON.stringify(record) + "\n")
    if (buffer.length > MAX_RECORD_BYTES) { this.counters.droppedOversize++; return }
    if (this.queue.length + this.inFlight >= 1024 || this.bytes + buffer.length > 1024 * 1024) { this.counters.droppedQueue++; return }
    this.queue.push(buffer); this.bytes += buffer.length; this.counters.admitted++
    if (this.queue.length >= 64) this.drain()
    else if (!this.timer) { this.timer = setTimeout(() => { this.timer = undefined; this.drain() }, this.limits.flushMs); this.timer.unref() }
  }

  diagnostic(value: Diagnostic) {
    const event = diagnosticEvents[value.event]
    if (!event) return
    this.record({ ...value, event, apiModelID: value.model, modelID: value.configuredModelID,
      ...(value.event === "warm-completed" ? { usageSource: "provider-response" } : {}) })
  }

  private health(extra: Partial<JournalData> = {}) { this.record({ event: "journal.health", ...this.counters, ...extra }) }

  private pause(reason: NonNullable<Journal["paused"]>) {
    if (this.paused !== reason) {
      this.paused = reason; this.pauseStartedAt ??= Date.now()
      try { this.warn({ event: "journal-degraded", reason }) } catch { /* Observability cannot control warming. */ }
    }
    this.retryAt = Date.now() + this.limits.retryMs
  }

  /** A deadline marks degradation; the underlying I/O still owns this writer until settlement. */
  private async io<T>(operation: () => Promise<T>): Promise<T> {
    let late = false
    const timer = setTimeout(() => { late = true; this.pause("io-timeout") }, this.limits.ioMs)
    timer.unref()
    try {
      const result = await operation()
      if (late) {
        if (object(result) && typeof result.close === "function") await result.close().catch(() => {})
        throw new Error("io-timeout")
      }
      return result
    } finally { clearTimeout(timer) }
  }

  private async initialize() {
    await this.io(() => mkdir(join(this.root, "events"), { recursive: true, mode: 0o700 }))
    if (this.closed) return
    await this.io(() => mkdir(join(this.root, "policy"), { recursive: true, mode: 0o700 }))
    if (this.closed) return
    if (!this.startupOnly) await this.io(() => this.register(join(this.root, "policy"), this.runID, this.options, () => !this.closed, this.registration))
    this.initialized = true
  }

  private async policyAndSpace() {
    if (this.closed) return
    const policy = await this.io(() => readPolicy(join(this.root, "policy")))
    if (!policy && !this.startupOnly) throw new Error("policy-unavailable")
    const next = policy ?? { schema: 1 as const, generation: 0, runID: this.runID, ...this.options }
    if (next.generation !== this.policy?.generation) {
      this.policy = next; this.scannedAt = 0
      this.record({ event: "journal.policy-observed", policyGeneration: next.generation || undefined,
        retentionDays: next.retentionDays, maxBytes: next.maxBytes })
    }
    if (next.maxBytes !== undefined && (!this.scannedAt || Date.now() - this.scannedAt >= 30_000 || this.paused === "pressure")) {
      this.estimatedBytes = await this.io(async () => {
        let total = 0, n = 0
        for (const directory of ["events", "policy"]) {
          for await (const entry of await opendir(join(this.root, directory))) {
            if (this.closed) throw new Error("storage-error")
            if (entry.isFile()) total += await stat(join(this.root, directory, entry.name)).then((s) => s.size, (e: unknown) => {
              if (code(e) === "ENOENT") return 0
              throw e
            })
            if (++n % 256 === 0) await yieldTurn()
          }
        }
        return total
      })
      this.scannedAt = Date.now()
    }
  }

  private async closeSegment(complete: boolean) {
    const file = this.file, path = this.filePath
    this.file = undefined; this.filePath = undefined
    if (!file || !path) return
    await this.io(() => file.close())
    if (complete && !this.closed) await this.io(() => rename(path, path.replace(/\.open$/, `.${this.fileMaxAt}.jsonl`)))
  }

  private async segment(at: number, bytes: number) {
    const date = new Date(at).toISOString().slice(0, 10)
    if (this.file && (this.fileBytes + bytes > this.limits.segmentBytes || date !== this.fileDate)) await this.closeSegment(true)
    if (this.file) return
    if (this.closed) return
    const index = this.index++
    this.filePath = join(this.root, "events", `${this.runID}.${process.pid}.${index}.open`)
    this.file = await this.io(() => open(this.filePath!, "wx", 0o600))
    if (this.closed) return
    const header: SegmentHeader = { schema: 1, recordKind: "segment", runID: this.runID, pid: process.pid, index,
      createdAt: new Date(at).toISOString(), pluginVersion: PLUGIN_VERSION,
      ...(this.projectID === undefined ? {} : { projectID: this.projectID }),
      ...(this.policy?.generation ? { policyGeneration: this.policy.generation } : {}) }
    const buffer = Buffer.from(JSON.stringify(header) + "\n")
    await this.io(() => this.write(this.file!, buffer))
    this.fileBytes = buffer.length; this.estimatedBytes += buffer.length; this.fileMaxAt = at; this.fileDate = date
  }

  private async prune() {
    if (this.startupOnly || (!this.cleanup && Date.now() < this.cleanupAt)) return
    this.cleanup ??= segmentFiles(join(this.root, "events"))
    const start = Date.now()
    for (let n = 0; n < 32 && !this.closed && Date.now() - start < 10_000; n++) {
      const next = await this.io(() => this.cleanup!.next())
      if (next.done) { this.cleanup = undefined; this.cleanupAt = Date.now() + 3_600_000; break }
      const path = next.value
      if (path === this.filePath) continue
      if (path.endsWith(".open")) {
        const pid = Number(basename(path).split(".")[1])
        try { process.kill(pid, 0); continue } catch (error) { if (code(error) !== "ESRCH") continue }
      }
      const policy = await this.io(() => readPolicy(join(this.root, "policy")))
      if (!policy) throw new Error("policy-unavailable")
      const cutoff = Date.now() - policy.retentionDays * DAY_MS
      let maximum = 0, valid = true
      await this.io(async () => {
        for await (const result of readSegment(path)) {
          if (result.issue || result.pending) valid = false
          if (result.record) maximum = Math.max(maximum, Date.parse(result.record.recordKind === "event" ? result.record.recordedAt : result.record.createdAt))
        }
      })
      if (!this.closed && valid && maximum && maximum < cutoff) await this.io(() => unlink(path).catch((e: unknown) => { if (code(e) !== "ENOENT") throw e }))
    }
  }

  private drain() {
    if (this.work || this.closed || (this.paused && Date.now() < this.retryAt)) return
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    this.work = this.flushWork().catch(async (error: unknown) => {
      this.pause(error instanceof Error && error.message === "policy-unavailable" ? "policy-unavailable" : this.paused === "io-timeout" ? "io-timeout" : "storage-error")
      this.counters.droppedStorage += this.queue.length
      this.queue = []; this.bytes = 0; this.inFlight = 0
      await this.closeSegment(false).catch(() => {})
    }).finally(() => {
      this.work = undefined
      if (!this.closed && !this.paused && this.queue.length) this.drain()
    })
  }

  private async flushWork() {
    if (!this.initialized) await this.initialize()
    if (this.closed) return
    await this.prune()
    await this.policyAndSpace()
    if (this.closed) return
    if (this.paused) {
      const previous = this.paused
      if (this.policy?.maxBytes !== undefined && this.estimatedBytes + MAX_RECORD_BYTES > this.policy.maxBytes) {
        this.pause("pressure"); return
      }
      this.paused = undefined
      this.health({ reason: previous, pauseStartedAt: this.pauseStartedAt, pauseEndedAt: Date.now() })
      this.pauseStartedAt = undefined
    }
    while (this.queue.length && !this.closed) {
      await this.policyAndSpace()
      let size = 0, n = 0
      for (const buffer of this.queue) { if (size + buffer.length > 64 * 1024) break; size += buffer.length; n++ }
      if (this.policy?.maxBytes !== undefined && this.estimatedBytes + size + MAX_RECORD_BYTES > this.policy.maxBytes) {
        this.pause("pressure"); this.counters.droppedPressure += this.queue.length
        this.bytes -= this.queue.reduce((sum, b) => sum + b.length, 0); this.queue = []; return
      }
      const batch = this.queue.splice(0, n); this.inFlight = n
      try {
        // Rotate on record boundaries, including small test segment limits.
        for (const buffer of batch) {
          const at = Date.parse((JSON.parse(buffer.toString()) as EventRecord).recordedAt)
          await this.segment(at, buffer.length)
          if (this.closed) break
          await this.io(() => this.write(this.file!, buffer))
          this.fileBytes += buffer.length; this.estimatedBytes += buffer.length; this.fileMaxAt = Math.max(this.fileMaxAt, at)
        }
      } catch (error) { this.counters.unconfirmedWrite += n; throw error }
      finally { this.inFlight = 0; this.bytes = Math.max(0, this.bytes - size) }
    }
  }

  async flush() {
    this.drain()
    while (this.work) await this.work
  }

  async dispose() {
    if (this.closing || this.closed) return
    if (!this.startupOnly) this.health()
    this.record({ event: "run.ended", ...this.counters })
    this.closing = true
    if (this.timer) clearTimeout(this.timer)
    if (this.heartbeat) clearInterval(this.heartbeat)
    // A pending syscall may outlive this deadline, but no subsequent recording may start.
    const shutdown = (async () => { await this.flush(); await this.closeSegment(!this.paused); await this.cleanup?.return(undefined) })()
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([shutdown.catch(() => {}), new Promise<void>((resolve) => { timer = setTimeout(resolve, 2000) })]) }
    finally { if (timer) clearTimeout(timer); this.closed = true; this.queue = []; this.bytes = 0 }
  }
}
