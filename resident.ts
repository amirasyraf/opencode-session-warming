/**
 * Process-scoped warming residents, one per OpenCode location.
 *
 * OpenCode V2 invalidates a location's service graph, including every plugin scope, after 60 minutes without
 * durable session events, and reloads it on the next request for that location. Warm replays are independent
 * HTTP calls that need only RAM state, timers, and `fetch`, never the location's services. A plugin scope therefore
 * attaches to its location's resident instead of owning the warming engine: the last scope to detach parks a
 * resident that still has live windows, and the next scope for the same location and options re-attaches to it.
 * A parked resident releases itself when its last window ends. Nothing here survives the process.
 *
 * Residents loaded by older plugin code stay in the pool across reloads, so the pool contract (`fingerprint`,
 * `scopes`, `idle`, `watchIdle`, `dispose`) is fixed. Bump RESIDENT_VERSION whenever anything else that an
 * attaching scope relies on changes: a mismatch disposes the old resident instead of adopting it.
 */
export const RESIDENT_VERSION = 1

export type Resident = {
  readonly fingerprint: string
  /** Attached plugin scopes. */
  scopes: number
  idle: () => boolean
  watchIdle: (callback: () => void) => void
  dispose: () => Promise<void>
}

const pool: Map<string, Resident> = ((globalThis as Record<symbol, unknown>)[Symbol.for("opencode-session-warming.residents")] ??=
  new Map<string, Resident>()) as Map<string, Resident>

export function locationKey(location: { directory?: unknown; workspaceID?: unknown } | undefined) {
  return `${String(location?.directory ?? "")}\0${String(location?.workspaceID ?? "")}`
}

export function fingerprint(options: Record<string, unknown>) {
  return JSON.stringify([RESIDENT_VERSION, options])
}

function release(key: string, resident: Resident) {
  if (pool.get(key) === resident) pool.delete(key)
  return resident.dispose().catch(() => {})
}

/** Attach a scope to the location's resident, creating it when absent or built from other code or options. */
export function attach<T extends Resident>(key: string, print: string, create: () => T): { resident: T; adopted: boolean } {
  const existing = pool.get(key)
  if (existing?.fingerprint === print) {
    existing.scopes++
    return { resident: existing as T, adopted: true }
  }
  if (existing) void release(key, existing)
  const resident = create()
  resident.scopes = 1
  pool.set(key, resident)
  return { resident, adopted: false }
}

/** Detach a scope. The last scope parks a resident with live windows; otherwise it is disposed. */
export async function detach(key: string, resident: Resident): Promise<"attached" | "parked" | "disposed"> {
  resident.scopes = Math.max(0, resident.scopes - 1)
  if (resident.scopes > 0) return "attached"
  if (pool.get(key) === resident && !resident.idle()) {
    resident.watchIdle(() => { if (resident.scopes === 0) void release(key, resident) })
    return "parked"
  }
  await release(key, resident)
  return "disposed"
}

/** Dispose a parked resident for a location whose plugin is now disabled or unsupported. */
export async function discard(key: string) {
  const existing = pool.get(key)
  if (existing && existing.scopes === 0) await release(key, existing)
}

/** Dispose every resident in this process (tests). */
export async function disposeResidents() {
  for (const [key, resident] of [...pool]) await release(key, resident)
}
