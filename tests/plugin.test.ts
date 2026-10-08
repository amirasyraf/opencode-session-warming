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
import { readSegment, segmentFiles } from "../journal-reader.ts"

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
  sessionID, agent, model: { id: "gpt-test", providerID, api: { id: "gpt-test" } }, message: { id: messageID },
}) as Input
const params = { temperature: 1, topP: 1, topK: 1, maxOutputTokens: undefined, options: {} }

const wire: RequestInit[] = []
globalThis.fetch = (async (_url, init) => { wire.push(init!); return completedResponse() }) as typeof fetch

async function harness(get?: (id: string) => Promise<unknown>, overrides: Record<string, unknown> = {}) {
  const logs: Record<string, unknown>[] = []
  const client = {
    session: { get: async ({ path }: { path: { id: string } }) => ({ data: get ? await get(path.id) : {
      id: path.id, version: "1.18.30", parentID: path.id === "child" ? "root" : undefined,
    } }) },
    app: { log: async ({ body }: { body: { extra: Record<string, unknown> } }) => { logs.push(body.extra) } },
  }
  const hooks = await plugin({ client } as unknown as PluginInput, { intervalMs: 60000, durationMs: 120000, debug: true, ...overrides })
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

test("accepts every stable 1.18 patch and rejects adjacent or prerelease versions", async () => {
  for (const version of ["1.18.0", "1.18.35"]) {
    const h = await harness(async (id) => ({ id, version }))
    assert.ok((await h.headers())[CAPTURE_HEADER], version)
    await h.hooks.dispose!()
  }
  for (const version of ["1.17.99", "1.19.0", "1.18.36-beta.1", "1.18.01"]) {
    const h = await harness(async (id) => ({ id, version }))
    assert.deepEqual(await h.headers(), {}, version)
    assert.ok(h.logs.some((log) => log.reason === "unsupported-session-version"), version)
    await h.hooks.dispose!()
  }
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

test("journal observes ordinary root usage with warming overridden off and debug disabled", async () => {
  const h = await harness(undefined, { providers: { openai: { enabled: false } }, debug: false })
  const created = Date.now() - 1
  assert.deepEqual(await h.headers(input("observed-root")), {})
  await h.hooks.event!({ event: { type: "message.updated", properties: { info: { id: "observed-assistant", role: "assistant",
    sessionID: "observed-root", parentID: "user", providerID: "openai", modelID: "gpt-test", mode: "build", time: { created } } } } as any })
  await h.hooks.event!({ event: { type: "message.part.updated", properties: { part: { id: "observed-step", sessionID: "observed-root",
    messageID: "observed-assistant", type: "step-finish", cost: 0.25,
    tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 90, write: 0 } } } } } as any })
  await h.hooks.dispose!()
  const observed = []
  for await (const path of segmentFiles(join(stateHome, "opencode", "session-warming", "events"))) {
    for await (const { record } of readSegment(path)) if (record?.recordKind === "event" && record.partID === "observed-step") observed.push(record)
  }
  assert.equal(observed.length, 1)
  assert.equal(observed[0]!.uncachedInputTokens, 10)
  assert.equal(observed[0]!.costSource, "opencode-step")
})

test("Copilot target models are marked; switching to older/other models invalidates preparation", async () => {
  const h = await harness()
  for (const modelID of ["gpt-5.6-sol", "gpt-6.1-sol", "claude-sonnet-5", "claude-opus-5.5"]) {
    const value = input("root", "build", "github-copilot")
    value.model.api.id = modelID
    assert.ok((await h.headers(value))[CAPTURE_HEADER], modelID)
  }
  for (const modelID of ["gpt-5.5", "claude-opus-4.8", "claude-haiku-5", "gemini-3.5"]) {
    const value = input("root", "build", "github-copilot")
    value.model.api.id = modelID
    assert.deepEqual(await h.headers(value), {})
  }
  assert.ok(h.logs.some((entry) => entry.reason === "unsupported-model"))
  await h.hooks.dispose!()
})
