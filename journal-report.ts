import { object } from "./journal-schema.ts"
import type { EventRecord } from "./journal-schema.ts"

/** Per-1M-token rates keyed by provider API model ID. Units are whatever the caller supplies (USD, credits). */
export type Rates = Record<string, { input: number; cachedInput: number; cacheWrite?: number; output: number }>
type Counts = Record<string, number>
type Model = {
  ordinary: { steps: number; uncachedInputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number }
  warms: { completed: number; failed: number; aborted: number; hits: number; misses: number
    inputTokens: number; cachedTokens: number; cacheWriteTokens: number; outputTokens: number; failures: Counts }
  windows: { started: number; warmed: number; unterminated: number; ended: Counts; turnEnded: Counts }
  returns: { total: number; afterWarming: number; withinTtl: number; afterTtl: number; cacheHit: number; cacheMiss: number
    usageUnknown: number; byFinish: Counts; idleMinutes: Counts }
  cost?: { ordinary: number; warms: number; warmShare: number }
}
type Resumed = { key: string; ordinaryCallID?: string; idleMs: number; ttlMs?: number; finish?: string; attempted: number }

const IDLE_BUCKETS: [number, string][] = [[5, "<5"], [30, "5-30"], [60, "30-60"], [240, "60-240"], [Infinity, ">=240"]]
const rate = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0
const n = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0
const bump = (counts: Counts, key: string) => { counts[key] = (counts[key] ?? 0) + 1 }

export function parseRates(value: unknown): Rates | undefined {
  if (!object(value) || Object.keys(value).length > 512) return
  for (const [model, entry] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_.:/-]{1,160}$/.test(model) || !object(entry) ||
      Object.keys(entry).some((key) => !["input", "cachedInput", "cacheWrite", "output"].includes(key)) ||
      !rate(entry.input) || !rate(entry.cachedInput) || !rate(entry.output) || (entry.cacheWrite !== undefined && !rate(entry.cacheWrite))) return
  }
  return value as Rates
}

/**
 * Read-only aggregation of journal metadata into per-model warming economics. A warm or a resumed first step counts
 * as a cache hit when cached input is more than half of its input; this is a heuristic, not proof of a refresh.
 * Returns are only known for windows recorded by plugin versions that emit `window.resumed`.
 */
export class JournalReport {
  private models = new Map<string, Model>()
  private apiModels = new Map<string, string>()
  private started = new Map<string, string>()
  private ended = new Set<string>()
  private steps = new Map<string, { at: string; read: number; total: number }>()
  private resumed: Resumed[] = []
  private records = 0
  private from?: string
  private to?: string
  private rates?: Rates

  constructor(rates?: Rates) { this.rates = rates }

  private model(record: EventRecord): [string, Model] {
    const api = String(record.apiModelID ?? record.modelID ?? "unknown")
    const key = `${String(record.providerID ?? "unknown")}/${api}`
    this.apiModels.set(key, api)
    let model = this.models.get(key)
    if (!model) {
      model = { ordinary: { steps: 0, uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
        warms: { completed: 0, failed: 0, aborted: 0, hits: 0, misses: 0, inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, failures: {} },
        windows: { started: 0, warmed: 0, unterminated: 0, ended: {}, turnEnded: {} },
        returns: { total: 0, afterWarming: 0, withinTtl: 0, afterTtl: 0, cacheHit: 0, cacheMiss: 0, usageUnknown: 0, byFinish: {}, idleMinutes: {} } }
      this.models.set(key, model)
    }
    return [key, model]
  }

  add(record: EventRecord) {
    this.records++
    if (!this.from || record.recordedAt < this.from) this.from = record.recordedAt
    if (!this.to || record.recordedAt > this.to) this.to = record.recordedAt
    switch (record.event) {
      case "ordinary.step-usage": {
        const [, model] = this.model(record)
        const uncached = n(record.uncachedInputTokens), read = n(record.cacheReadTokens), write = n(record.cacheWriteTokens)
        model.ordinary.steps++
        model.ordinary.uncachedInputTokens += uncached
        model.ordinary.cacheReadTokens += read
        model.ordinary.cacheWriteTokens += write
        model.ordinary.outputTokens += n(record.nonReasoningOutputTokens) + n(record.reasoningTokens)
        const id = typeof record.ordinaryCallID === "string" ? record.ordinaryCallID : undefined
        const first = id ? this.steps.get(id) : undefined
        if (id && (!first || record.recordedAt < first.at)) this.steps.set(id, { at: record.recordedAt, read, total: uncached + read + write })
        return
      }
      case "warm.completed": {
        const [, model] = this.model(record)
        const input = n(record.inputTokens), cached = n(record.cachedTokens)
        model.warms.completed++
        if (input > 0 && cached > input / 2) model.warms.hits++
        else model.warms.misses++
        model.warms.inputTokens += input
        model.warms.cachedTokens += cached
        model.warms.cacheWriteTokens += n(record.cacheWriteTokens)
        model.warms.outputTokens += n(record.outputTokens)
        return
      }
      case "warm.failed": {
        const [, model] = this.model(record)
        model.warms.failed++
        bump(model.warms.failures, String(record.reason ?? "unclassified"))
        return
      }
      case "warm.aborted": this.model(record)[1].warms.aborted++; return
      case "window.started": {
        const [key, model] = this.model(record)
        model.windows.started++
        if (typeof record.windowID === "string") this.started.set(record.windowID, key)
        return
      }
      case "window.ended": {
        if (typeof record.windowID !== "string") return
        const [, model] = this.model(record)
        this.ended.add(record.windowID)
        bump(model.windows.ended, String(record.reason ?? "unclassified"))
        if (n(record.attempted) > 0) model.windows.warmed++
        return
      }
      case "window.turn-ended": bump(this.model(record)[1].windows.turnEnded, String(record.finish ?? "unknown")); return
      case "window.resumed": {
        const [key] = this.model(record)
        this.resumed.push({ key, ordinaryCallID: typeof record.ordinaryCallID === "string" ? record.ordinaryCallID : undefined,
          idleMs: n(record.idleMs), ttlMs: typeof record.ttlMs === "number" ? record.ttlMs : undefined,
          finish: typeof record.finish === "string" ? record.finish : undefined, attempted: n(record.attempted) })
      }
    }
  }

  result() {
    for (const [windowID, key] of this.started) if (!this.ended.has(windowID)) this.models.get(key)!.windows.unterminated++
    for (const item of this.resumed) {
      const returns = this.models.get(item.key)!.returns
      returns.total++
      if (item.attempted > 0) returns.afterWarming++
      if (item.ttlMs !== undefined) {
        if (item.idleMs < item.ttlMs) returns.withinTtl++
        else returns.afterTtl++
      }
      bump(returns.byFinish, item.finish ?? "unknown")
      bump(returns.idleMinutes, IDLE_BUCKETS.find(([limit]) => item.idleMs / 60_000 < limit)![1])
      const step = item.ordinaryCallID ? this.steps.get(item.ordinaryCallID) : undefined
      if (!step || !step.total) returns.usageUnknown++
      else if (step.read > step.total / 2) returns.cacheHit++
      else returns.cacheMiss++
    }
    let ordinaryTotal = 0, warmTotal = 0
    if (this.rates) for (const [key, model] of this.models) {
      const price = this.rates[this.apiModels.get(key)!]
      if (!price) continue
      const write = price.cacheWrite ?? price.input
      const o = model.ordinary, w = model.warms
      const ordinary = (o.uncachedInputTokens * price.input + o.cacheReadTokens * price.cachedInput + o.cacheWriteTokens * write + o.outputTokens * price.output) / 1e6
      const warms = (Math.max(0, w.inputTokens - w.cachedTokens - w.cacheWriteTokens) * price.input + w.cachedTokens * price.cachedInput +
        w.cacheWriteTokens * write + w.outputTokens * price.output) / 1e6
      model.cost = { ordinary, warms, warmShare: ordinary + warms ? warms / (ordinary + warms) : 0 }
      ordinaryTotal += ordinary; warmTotal += warms
    }
    return { from: this.from, to: this.to, records: this.records,
      ...(this.rates ? { cost: { ordinary: ordinaryTotal, warms: warmTotal, warmShare: ordinaryTotal + warmTotal ? warmTotal / (ordinaryTotal + warmTotal) : 0 } } : {}),
      models: Object.fromEntries([...this.models].sort(([a], [b]) => a.localeCompare(b))) }
  }
}
