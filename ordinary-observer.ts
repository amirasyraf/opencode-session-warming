import { randomUUID } from "node:crypto"
import type { Event } from "@opencode-ai/sdk"
import { identifier, safeData } from "./journal-schema.ts"
import type { JournalData } from "./journal-schema.ts"
import type { Journal } from "./journal.ts"
import type { UsageStats } from "./status.ts"

type Call = { sessionID: string; userMessageID: string; providerID: string; modelID: string; apiModelID: string; at: number; ordinaryCallID: string }
type Assistant = { sessionID: string; userMessageID: string; assistantMessageID: string; providerID: string; modelID: string;
  startedAt: number; completedAt?: number; excluded: boolean; admitted: boolean; finish?: string; errorCategory?: string }
type Pending = { data: JournalData; at: number; bytes: number }
type NormalizedTokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }

const positive = (value: number | undefined) => typeof value === "number" && value > 0 ? value : undefined
export function normalizedUsage(tokens: NormalizedTokens): UsageStats | undefined {
  const usage: UsageStats = {
    uncachedInputTokens: positive(tokens.input), cachedTokens: positive(tokens.cache.read), cacheWriteTokens: positive(tokens.cache.write),
  }
  const output = tokens.output + tokens.reasoning
  if (output > 0) usage.outputTokens = output
  return Object.values(usage).some((value) => value !== undefined) ? usage : undefined
}

/** Observe live source metadata, never reconstruct or fetch conversation history. */
export class OrdinaryObserver {
  private journal: Journal
  private roots = new Map<string, boolean>()
  private calls = new Map<string, Call>()
  private assistants = new Map<string, Assistant>()
  private seen = new Map<string, string>()
  private pending = new Map<string, Pending>()
  private pendingBytes = 0
  private timer: ReturnType<typeof setInterval>
  private onUsage?: (sessionID: string, usage: UsageStats) => void
  constructor(journal: Journal, onUsage?: (sessionID: string, usage: UsageStats) => void) {
    this.journal = journal
    this.onUsage = onUsage
    this.timer = setInterval(() => this.expire(), 1000)
    this.timer.unref()
  }

  private put<T>(map: Map<string, T>, key: string, value: T, limit = 4096) {
    map.delete(key); map.set(key, value)
    if (map.size > limit) { map.delete(map.keys().next().value!); this.journal.counters.evictedMetadata++ }
  }

  classify(sessionID: string, root: boolean) { this.put(this.roots, sessionID, root, 1024) }

  call(value: Omit<Call, "ordinaryCallID">, version: string): string {
    const ordinaryCallID = randomUUID()
    if (this.roots.get(value.sessionID) !== true || !["openai", "github-copilot"].includes(value.providerID)) return ordinaryCallID
    this.put(this.calls, ordinaryCallID, { ...value, ordinaryCallID })
    this.journal.record({ event: "ordinary.call-started", ...value, ordinaryCallID, startedAt: value.at, version })
    this.retry()
    return ordinaryCallID
  }

  private candidates(info: Assistant): Call[] {
    return [...this.calls.values()].filter((call) => call.sessionID === info.sessionID && call.userMessageID === info.userMessageID &&
      call.providerID === info.providerID && call.modelID === info.modelID && info.startedAt <= call.at &&
      (info.completedAt === undefined || call.at <= info.completedAt))
  }

  private emit(data: JournalData): boolean {
    const info = this.assistants.get(String(data.assistantMessageID))
    const root = this.roots.get(String(data.sessionID))
    if (root === false || info?.excluded) { this.journal.counters.excludedMetadata++; return true }
    if (!info || root !== true) return false
    const candidates = this.candidates(info)
    if (!info.admitted && !candidates.length) return false
    info.admitted = true
    const call = candidates.length === 1 ? candidates[0] : undefined
    if (!call) this.journal.counters.unattributed++
    const value = safeData({ ...data, providerID: info.providerID, modelID: info.modelID, userMessageID: info.userMessageID,
      ordinaryCallID: call?.ordinaryCallID, apiModelID: call?.apiModelID })!
    const key = `${data.event}:${data.assistantMessageID}:${data.partID ?? "outcome"}`
    const fingerprint = JSON.stringify(value)
    const first = this.seen.get(key) === undefined
    if (first || this.seen.get(key) !== fingerprint) {
      this.put(this.seen, key, fingerprint); this.journal.record(value)
      if (first && value.event === "ordinary.step-usage") {
        const usage = normalizedUsage({ input: Number(value.uncachedInputTokens ?? 0), output: Number(value.nonReasoningOutputTokens ?? 0),
          reasoning: Number(value.reasoningTokens ?? 0), cache: { read: Number(value.cacheReadTokens ?? 0), write: Number(value.cacheWriteTokens ?? 0) } })
        if (usage) this.onUsage?.(String(value.sessionID), usage)
      }
    }
    return true
  }

  private observe(value: unknown) {
    const data = safeData(value)
    if (!data || !identifier(data.sessionID) || !identifier(data.assistantMessageID)) { this.journal.counters.excludedMetadata++; return }
    if (this.emit(data)) return
    const key = `${data.event}:${data.assistantMessageID}:${data.partID ?? "outcome"}`
    const previous = this.pending.get(key)
    if (previous) this.pendingBytes -= previous.bytes
    this.pending.delete(key)
    const bytes = Buffer.byteLength(JSON.stringify(data))
    if (this.pending.size >= 128 || this.pendingBytes + bytes > 1024 * 1024) { this.journal.counters.excludedMetadata++; return }
    this.pending.set(key, { data, bytes, at: Date.now() }); this.pendingBytes += bytes
  }

  private retry() {
    for (const [key, item] of this.pending) {
      if (this.emit(item.data)) { this.pending.delete(key); this.pendingBytes -= item.bytes }
    }
    this.expire()
  }

  private expire() {
    for (const [key, item] of this.pending) {
      if (Date.now() - item.at >= 5000) {
        this.pending.delete(key); this.pendingBytes -= item.bytes; this.journal.counters.excludedMetadata++
      }
    }
  }

  event(event: Event) {
    if (event.type === "message.updated" && event.properties.info.role === "assistant") {
      const info = event.properties.info
      if (!identifier(info.id) || !identifier(info.sessionID) || !identifier(info.parentID) || !identifier(info.providerID) ||
        !identifier(info.modelID) || !Number.isFinite(info.time.created)) { this.journal.counters.excludedMetadata++; return }
      const previous = this.assistants.get(info.id)
      const errorCategory = info.error ? info.error.name === "MessageAbortedError" ? "aborted" :
        info.error.name === "ProviderAuthError" ? "auth" : "other" : undefined
      const assistant: Assistant = { sessionID: info.sessionID, userMessageID: info.parentID, assistantMessageID: info.id,
        providerID: info.providerID, modelID: info.modelID, startedAt: info.time.created, completedAt: info.time.completed,
        excluded: !!info.summary || ["title", "summary", "compaction"].includes(info.mode) || !["openai", "github-copilot"].includes(info.providerID),
        admitted: previous?.admitted ?? false, errorCategory,
        finish: info.finish === undefined ? undefined : ["stop", "tool-calls", "length", "content-filter", "error"].includes(info.finish) ? info.finish : "other" }
      this.put(this.assistants, info.id, assistant)
      if (info.time.completed !== undefined) this.observe({ event: "ordinary.message-completed", sessionID: info.sessionID,
        assistantMessageID: info.id, startedAt: info.time.created, completedAt: info.time.completed, errorCategory, finish: assistant.finish })
      this.retry()
    }
    if (event.type === "message.part.updated" && event.properties.part.type === "step-finish") {
      const part = event.properties.part
      if (!identifier(part.id)) { this.journal.counters.excludedMetadata++; return }
      this.observe({ event: "ordinary.step-usage", sessionID: part.sessionID, assistantMessageID: part.messageID, partID: part.id,
        uncachedInputTokens: part.tokens.input, cacheReadTokens: part.tokens.cache.read, cacheWriteTokens: part.tokens.cache.write,
        nonReasoningOutputTokens: part.tokens.output, reasoningTokens: part.tokens.reasoning, reportedCost: part.cost,
        usageSource: "opencode-normalized", upstreamUsageAvailability: "unknown", costSource: "opencode-step", costUnit: "unspecified" })
    }
    if (event.type === "session.deleted") {
      const id = event.properties.info.id
      this.roots.delete(id)
      for (const [key, item] of this.calls) if (item.sessionID === id) this.calls.delete(key)
      for (const [key, item] of this.assistants) if (item.sessionID === id) this.assistants.delete(key)
      for (const [key, item] of this.pending) if (item.data.sessionID === id) { this.pending.delete(key); this.pendingBytes -= item.bytes }
    }
  }

  dispose() {
    clearInterval(this.timer)
    this.journal.counters.excludedMetadata += this.pending.size
    this.pending.clear(); this.roots.clear(); this.calls.clear(); this.assistants.clear(); this.seen.clear(); this.pendingBytes = 0
  }
}
