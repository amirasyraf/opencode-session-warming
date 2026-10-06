import assert from "node:assert/strict"
import { after, test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import plugin from "../plugin.ts"
import { CAPTURE_HEADER } from "../protocol.ts"
import { completedResponse, ordinary } from "./helpers.ts"

const stateHome = await mkdtemp(join(tmpdir(), "warming-plugin-unit-"))
const previousStateHome = process.env.XDG_STATE_HOME
process.env.XDG_STATE_HOME = stateHome
after(async () => {
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = previousStateHome
  await rm(stateHome, { recursive: true, force: true })
})

type Input = Parameters<NonNullable<Hooks["chat.params"]>>[0]
const input = (sessionID = "root", agent = "build", providerID = "openai", messageID = "user") => ({
  sessionID, agent, model: { providerID }, message: { id: messageID },
}) as Input
const params = { temperature: 1, topP: 1, topK: 1, maxOutputTokens: undefined, options: {} }

const wire: RequestInit[] = []
globalThis.fetch = (async (_url, init) => { wire.push(init!); return completedResponse() }) as typeof fetch

async function harness(get?: (id: string) => Promise<unknown>) {
  const logs: Record<string, unknown>[] = []
  const client = {
    session: { get: async ({ path }: { path: { id: string } }) => ({ data: get ? await get(path.id) : {
      id: path.id, version: "1.18.30", parentID: path.id === "child" ? "root" : undefined,
    } }) },
    app: { log: async ({ body }: { body: { extra: Record<string, unknown> } }) => { logs.push(body.extra) } },
  }
  const hooks = await plugin({ client } as unknown as PluginInput, { intervalMs: 60000, durationMs: 120000, debug: true })
  async function headers(value = input()) {
    await hooks["chat.params"]!(value, params)
    const out = { headers: {} as Record<string, string> }
    await hooks["chat.headers"]!(value, out)
    return out.headers
  }
  return { hooks, headers, logs }
}

test("root capture follows OAuth routing, excludes children/hidden calls and preserves ordinary parameters", async () => {
  const h = await harness()
  const headers = await h.headers()
  assert.ok(headers[CAPTURE_HEADER])
  const [url, init] = ordinary()
  const merged = new Headers(init.headers)
  merged.set(CAPTURE_HEADER, headers[CAPTURE_HEADER])
  // Represents the final request after the existing OAuth handler injected authentication.
  await (await globalThis.fetch(url, { ...init, headers: merged })).text()
  assert.equal(new Headers(wire.at(-1)!.headers).get("authorization"), "Bearer test-only")
  assert.equal(new Headers(wire.at(-1)!.headers).has(CAPTURE_HEADER), false)
  assert.ok(h.logs.some((log) => log.event === "captured"))
  assert.deepEqual(await h.headers(input("child")), {})
  assert.deepEqual(await h.headers(input("root", "title")), {})
  assert.deepEqual(await h.headers(input("root", "summary")), {})
  assert.equal(h.logs.filter((log) => log.event === "stopped").length, 0)
  assert.deepEqual(await h.headers(input("root", "build", "google")), {})
  assert.ok(h.logs.some((log) => log.reason === "ordinary-activity"))
  assert.equal(params.maxOutputTokens, undefined)
  await h.hooks.dispose!()
})

test("cancellation/revert/compaction events clear captures and disposed hooks remain inert", async () => {
  const h = await harness()
  await h.headers()
  await h.hooks.event!({ event: { type: "session.error", properties: { sessionID: "root" } } })
  assert.ok(h.logs.some((log) => log.reason === "session-error"))
  await h.headers()
  await h.hooks["experimental.session.compacting"]!({ sessionID: "root" }, { context: [] })
  assert.ok(h.logs.some((log) => log.reason === "compacting"))
  await h.headers()
  await h.hooks.event!({ event: { type: "session.updated", properties: { info: {
    id: "root", revert: { messageID: "reverted-message" },
  } } } } as Parameters<NonNullable<Hooks["event"]>>[0])
  assert.ok(h.logs.some((log) => log.reason === "reverted"))
  const lateHeaders = await h.headers()
  await h.hooks.dispose!()
  await h.hooks["chat.params"]!(input(), params)
  const out = { headers: {} }
  await h.hooks["chat.headers"]!(input(), out)
  assert.deepEqual(out.headers, {})
  const [url, init] = ordinary()
  await globalThis.fetch(url, { ...init, headers: { ...lateHeaders } })
  assert.equal(new Headers(wire.at(-1)!.headers).has(CAPTURE_HEADER), false)
})

test("late session-metadata lookups cannot revive invalidated or newer preparation", async () => {
  let resolve: (value: unknown) => void = () => {}
  let calls = 0
  const h = await harness(async (id) => {
    if (++calls === 1) return new Promise((done) => { resolve = done })
    return { id, version: "1.18.30" }
  })
  const first = h.hooks["chat.params"]!(input("root", "build", "openai", "old"), params)
  const newHeaders = await h.headers(input("root", "build", "openai", "new"))
  resolve({ id: "root", version: "1.18.30" })
  await first
  const out = { headers: {} as Record<string, string> }
  await h.hooks["chat.headers"]!(input("root", "build", "openai", "new"), out)
  assert.deepEqual(out.headers, newHeaders)
  await h.hooks.dispose!()
})

test("unsupported transports and invalid options emit no capture hooks", async () => {
  const h = await harness()
  await h.hooks.dispose!()
  const client = { app: { log: async () => {} } }
  const old = process.env.OPENCODE_EXPERIMENTAL_WEBSOCKETS
  process.env.OPENCODE_EXPERIMENTAL_WEBSOCKETS = "true"
  try { assert.deepEqual(await plugin({ client } as unknown as PluginInput), {}) }
  finally {
    if (old === undefined) delete process.env.OPENCODE_EXPERIMENTAL_WEBSOCKETS
    else process.env.OPENCODE_EXPERIMENTAL_WEBSOCKETS = old
  }
  assert.deepEqual(await plugin({ client } as unknown as PluginInput, { intervalMs: -1 }), {})
})

test("startup logs effective configuration and distinguishes unsupported providers", async () => {
  const h = await harness()
  await h.headers(input("root", "build", "google"))
  const ready = h.logs.find((entry) => entry.event === "ready")!
  assert.equal(ready.intervalMs, 60000)
  assert.equal(ready.durationMs, 120000)
  assert.ok(h.logs.some((entry) => entry.reason === "unsupported-provider"))
  await h.hooks.dispose!()
})

test("metadata lookup cannot indefinitely block the parent request", { timeout: 7000 }, async () => {
  const h = await harness(async () => new Promise(() => {}))
  await Promise.all([h.headers(), sleep(5100)]) // Keep the test event loop alive while production timers are unref'ed.
  assert.ok(h.logs.some((entry) => entry.reason === "session-metadata-unavailable" && entry.errorCode === "metadata-timeout"))
  const out = { headers: {} }
  await h.hooks["chat.headers"]!(input(), out)
  assert.deepEqual(out.headers, {})
  await h.hooks.dispose!()
})
