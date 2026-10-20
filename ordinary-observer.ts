import { randomUUID } from "node:crypto"
import { identifier, object, safeData } from "./journal-schema.ts"
import type { JournalData } from "./journal-schema.ts"
import type { Journal } from "./journal.ts"
import type { UsageStats } from "./status.ts"

type Call = { sessionID: string; providerID: string; modelID: string; apiModelID: string; at: number; ordinaryCallID: string; consumed: boolean }
type Step = { sessionID: string; assistantMessageID: string; providerID: string; modelID: string; startedAt: number
  excluded: boolean; ordinaryCallID?: string; apiModelID?: string }
type Pending = { data: JournalData; at: number; bytes: number }
type NormalizedTokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
type Counters = { excludedMetadata: number; evictedMetadata: number; unattributed: number }
const SUPPORTED = ["openai", "github-copilot"]
const CALL_TTL_MS = 600_000

const positive = (value: number | undefined) => typeof value === "number" && value > 0 ? value : undefined
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0
export function normalizedUsage(tokens: NormalizedTokens): UsageStats | undefined {
  const usage: UsageStats = {
    uncachedInputTokens: positive(tokens.input), cachedTokens: positive(tokens.cache.read), cacheWriteTokens: positive(tokens.cache.write),
  }
  const output = tokens.output + tokens.reasoning
  if (output > 0) usage.outputTokens = output
  return Object.values(usage).some((value) => value !== undefined) ? usage : undefined
}

function tokens(value: unknown): NormalizedTokens | undefined {
  if (!object(value) || !object(value.cache) || ![value.input, value.output, value.reasoning, value.cache.read, value.cache.write].every(finite)) return
  return value as NormalizedTokens
}

/**
 * Attribute live OpenCode V2 `session.step.*` events to admitted root model calls. Never reads or
 * reconstructs conversation history; copied history, children, auxiliary requests, and unknown
 * eligibility are excluded, and ambiguous attribution is recorded as such rather than guessed.
 */
export class OrdinaryObserver {
  private journal?: Journal
  private counters: Counters
  private roots = new Map<string, boolean>()
  private calls = new Map<string, Call>()
  private steps = new Map<string, Step>()
  private seen = new Set<string>()
  private pending = new Map<string, Pending>()
  private pendingBytes = 0
  private timer: ReturnType<typeof setInterval>
  private onUsage?: (sessionID: string, usage: UsageStats) => void
  constructor(journal: Journal | undefined, onUsage?: (sessionID: string, usage: UsageStats) => void) {
    this.journal = journal
    this.counters = journal?.counters ?? { excludedMetadata: 0, evictedMetadata: 0, unattributed: 0 }
    this.onUsage = onUsage
    this.timer = setInterval(() => this.expire(), 1000)
    this.timer.unref()
  }

  private put<T>(map: Map<string, T>, key: string, value: T, limit = 4096) {
    map.delete(key); map.set(key, value)
    if (map.size > limit) { map.delete(map.keys().next().value!); this.counters.evictedMetadata++ }
  }

  classify(sessionID: string, root: boolean) { this.put(this.roots, sessionID, root, 1024); this.retry() }

  /** One ordinary root model request reached the provider dispatch hook. */
  call(value: Omit<Call, "ordinaryCallID" | "consumed">, version: string): string {
    const ordinaryCallID = randomUUID()
    if (this.roots.get(value.sessionID) !== true || !SUPPORTED.includes(value.providerID)) return ordinaryCallID
    this.put(this.calls, ordinaryCallID, { ...value, ordinaryCallID, consumed: false })
    this.journal?.record({ event: "ordinary.call-started", ...value, ordinaryCallID, startedAt: value.at, version })
    this.retry()
    return ordinaryCallID
  }

  private attribute(step: Step) {
    if (step.ordinaryCallID !== undefined) return
    const candidates = [...this.calls.values()].filter((call) => !call.consumed && call.sessionID === step.sessionID &&
      call.providerID === step.providerID && call.modelID === step.modelID && call.at <= step.startedAt && step.startedAt - call.at <= CALL_TTL_MS)
    if (candidates.length !== 1) { this.counters.unattributed++; step.ordinaryCallID = ""; return }
    candidates[0].consumed = true
    step.ordinaryCallID = candidates[0].ordinaryCallID
    step.apiModelID = candidates[0].apiModelID
  }

  private emit(data: JournalData): boolean {
    const step = this.steps.get(String(data.assistantMessageID))
    const root = this.roots.get(String(data.sessionID))
    if (root === false || step?.excluded) { this.counters.excludedMetadata++; return true }
    if (!step || root !== true) return false
    this.attribute(step)
    const key = `${data.event}:${data.assistantMessageID}`
    if (this.seen.has(key)) return true
    this.seen.add(key)
    if (this.seen.size > 8192) this.seen.delete(this.seen.values().next().value!)
    const value = safeData({ ...data, providerID: step.providerID, modelID: step.modelID,
      ordinaryCallID: step.ordinaryCallID || undefined, apiModelID: step.apiModelID })!
    this.journal?.record(value)
    if (value.event === "ordinary.step-usage") {
      const usage = normalizedUsage({ input: Number(value.uncachedInputTokens ?? 0), output: Number(value.nonReasoningOutputTokens ?? 0),
        reasoning: Number(value.reasoningTokens ?? 0), cache: { read: Number(value.cacheReadTokens ?? 0), write: Number(value.cacheWriteTokens ?? 0) } })
      if (usage) this.onUsage?.(String(value.sessionID), usage)
    }
    return true
  }

  private observe(value: Record<string, unknown>) {
    const data = safeData(value)
    if (!data || !identifier(data.sessionID) || !identifier(data.assistantMessageID)) { this.counters.excludedMetadata++; return }
    if (this.emit(data)) return
    const key = `${data.event}:${data.assistantMessageID}`
    const previous = this.pending.get(key)
    if (previous) this.pendingBytes -= previous.bytes
    this.pending.delete(key)
    const bytes = Buffer.byteLength(JSON.stringify(data))
    if (this.pending.size >= 128 || this.pendingBytes + bytes > 1024 * 1024) { this.counters.excludedMetadata++; return }
    this.pending.set(key, { data, bytes, at: Date.now() }); this.pendingBytes += bytes
  }

  private retry() {
    for (const [key, item] of this.pending) {
      if (this.emit(item.data)) { this.pending.delete(key); this.pendingBytes -= item.bytes }
    }
    this.expire()
  }

  private expire() {
    const now = Date.now()
    for (const [key, item] of this.pending) {
      if (now - item.at >= 5000) { this.pending.delete(key); this.pendingBytes -= item.bytes; this.counters.excludedMetadata++ }
    }
    for (const [key, call] of this.calls) if (now - call.at > CALL_TTL_MS) this.calls.delete(key)
  }

  /** Consume one V2 public event (`{ type, data }`). Unknown or malformed events are ignored. */
  event(event: { type: string; data?: unknown }) {
    const data = object(event.data) ? event.data : undefined
    if (!data) return
    if (event.type === "session.step.started") {
      const model = object(data.model) ? data.model : undefined
      if (!identifier(data.sessionID) || !identifier(data.assistantMessageID) || !model || !identifier(model.providerID) ||
        !identifier(model.id) || !finite(data.started)) { this.counters.excludedMetadata++; return }
      this.put(this.steps, data.assistantMessageID, { sessionID: data.sessionID, assistantMessageID: data.assistantMessageID,
        providerID: model.providerID, modelID: model.id, startedAt: data.started,
        excluded: !SUPPORTED.includes(model.providerID) || ["title", "summary", "compaction"].includes(String(data.agent)) })
      this.retry()
      return
    }
    if (event.type === "session.step.ended" || event.type === "session.step.failed") {
      const usage = tokens(data.tokens)
      const failed = event.type === "session.step.failed"
      const errorCategory = !failed ? undefined : object(data.error) && /abort|interrupt/i.test(String(data.error.type ?? data.error.name)) ? "aborted" :
        object(data.error) && /auth/i.test(String(data.error.type ?? data.error.name)) ? "auth" : "other"
      const finish = failed ? "error" : ["stop", "tool-calls", "length", "content-filter", "error"].includes(String(data.finish)) ? data.finish : "other"
      const step = this.steps.get(String(data.assistantMessageID))
      this.observe({ event: "ordinary.message-completed", sessionID: data.sessionID, assistantMessageID: data.assistantMessageID,
        startedAt: step?.startedAt, completedAt: Date.now(), errorCategory, finish })
      if (usage) this.observe({ event: "ordinary.step-usage", sessionID: data.sessionID, assistantMessageID: data.assistantMessageID,
        uncachedInputTokens: usage.input, cacheReadTokens: usage.cache.read, cacheWriteTokens: usage.cache.write,
        nonReasoningOutputTokens: usage.output, reasoningTokens: usage.reasoning, reportedCost: finite(data.cost) ? data.cost : undefined,
        usageSource: "opencode-normalized", upstreamUsageAvailability: "unknown", costSource: "opencode-step", costUnit: "unspecified" })
      return
    }
    if (event.type === "session.deleted" && identifier(data.sessionID)) this.forget(data.sessionID)
  }

  forget(id: string) {
    this.roots.delete(id)
    for (const [key, item] of this.calls) if (item.sessionID === id) this.calls.delete(key)
    for (const [key, item] of this.steps) if (item.sessionID === id) this.steps.delete(key)
    for (const [key, item] of this.pending) if (item.data.sessionID === id) { this.pending.delete(key); this.pendingBytes -= item.bytes }
  }

  dispose() {
    clearInterval(this.timer)
    this.counters.excludedMetadata += this.pending.size
    this.pending.clear(); this.roots.clear(); this.calls.clear(); this.steps.clear(); this.seen.clear(); this.pendingBytes = 0
  }
}
