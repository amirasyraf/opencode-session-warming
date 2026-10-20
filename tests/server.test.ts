import assert from "node:assert/strict"
import { after, test } from "node:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { zstdCompressSync, zstdDecompressSync } from "node:zlib"
import plugin from "../server.ts"
import { CODEX_ENDPOINT, KEEPALIVE } from "../protocol.ts"
import { completedResponse, requestBody } from "./helpers.ts"

const stateHome = await mkdtemp(join(tmpdir(), "warming-server-unit-"))
const previousStateHome = process.env.XDG_STATE_HOME
process.env.XDG_STATE_HOME = stateHome
const originalFetch = globalThis.fetch
after(async () => {
  globalThis.fetch = originalFetch
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = previousStateHome
  await disposeAll()
  await rm(stateHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const active = new Set<() => Promise<void>>()
async function disposeAll() { for (const cleanup of [...active]) await cleanup() }

type Warm = { url: string; headers: Headers; body: Record<string, unknown> }
const warms: Warm[] = []
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers)
  const raw = init?.body as Uint8Array | string
  const text = headers.get("content-encoding") === "zstd" ? zstdDecompressSync(raw as Uint8Array).toString("utf8") : String(raw)
  warms.push({ url: String(input), headers, body: JSON.parse(text) })
  return completedResponse()
}) as typeof fetch

type Hook = { name: string; callback: (event: any) => unknown; providerID?: string }
const model = { providerID: "openai", id: "alias", variant: "default" }

async function harness(overrides: Record<string, unknown> = {}, app = { name: "opencode", version: "2.1.0", channel: "latest" }) {
  // A failed assertion must not leave an earlier harness warming into later tests.
  await disposeAll()
  warms.length = 0
  const hooks: Hook[] = []
  const emitted: Record<string, unknown>[] = []
  const queue: unknown[] = []
  let wake: (() => void) | undefined
  let handlers: Record<string, (input: unknown, context: unknown) => Promise<any>> = {}
  const sessions: Record<string, { id: string; parentID?: string }> = { root: { id: "root" }, child: { id: "child", parentID: "root" }, other: { id: "other" } }
  const ctx = {
    app, options: { intervalMs: 60, durationMs: 3000, debug: true, ...overrides },
    location: { directory: "/project", project: { id: "proj", directory: "/project", canonical: "/project" } },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => { const info = sessions[sessionID]; if (!info) throw new Error("not found"); return info },
      hook: async (name: string, callback: Hook["callback"], options?: { providerID?: string }) => {
        hooks.push({ name, callback, providerID: options?.providerID }); return { dispose: async () => {} }
      },
    },
    model: { list: async () => ({ data: [{ providerID: "openai", id: "alias", modelID: "gpt-test" },
      { providerID: "openai", id: "gpt-6.1-sol-fast", modelID: "gpt-6.1-sol" }] }) },
    rpc: { register: async (_definition: unknown, value: typeof handlers) => {
      handlers = value
      return { dispose: async () => {}, events: { emit: async (_name: string, data: Record<string, unknown>) => { emitted.push(data) } } }
    } },
    event: { subscribe: ({ signal }: { signal: AbortSignal }) => ({
      async *[Symbol.asyncIterator]() {
        while (!signal.aborted) {
          if (queue.length) { yield queue.shift(); continue }
          await new Promise<void>((resolve) => { wake = resolve; signal.addEventListener("abort", () => resolve(), { once: true }) })
        }
      },
    }) },
  }
  const dispose = await plugin.setup(ctx as never) as (() => Promise<void>) | undefined
  const cleanup = dispose && (async () => { if (active.delete(cleanup!)) await dispose() })
  if (cleanup) active.add(cleanup)
  async function trigger(name: string, event: Record<string, any>) {
    for (const hook of hooks) {
      if (hook.name !== name) continue
      if (hook.providerID && hook.providerID !== event.model?.providerID) continue
      await hook.callback(event)
    }
    return event
  }
  /** One ordinary agent-loop model request: context hook, native HTTP request, then a completed response. */
  async function ordinary(sessionID = "root", options: { body?: unknown; respond?: boolean; ref?: typeof model } = {}) {
    const ref = options.ref ?? model
    await trigger("context", { sessionID, agent: "build", model: ref, system: [], messages: [], options: {}, tools: {} })
    const request = new Request(CODEX_ENDPOINT, { method: "POST", body: zstdCompressSync(JSON.stringify(options.body ?? requestBody)),
      headers: { authorization: "Bearer test-only", "content-type": "application/json", "content-encoding": "zstd", "session-id": sessionID } })
    await trigger("http.request", { sessionID, agent: "build", model: ref, kind: "primary", request })
    if (options.respond === false) return request
    const event = await trigger("http.response", { sessionID, agent: "build", model: ref, kind: "primary", request, response: completedResponse() })
    await (event.response as Response).text()
    return request
  }
  return {
    hooks, emitted, sessions, trigger, ordinary, cleanup,
    rpc: (name: string, input: unknown) => handlers[name](input, { signal: new AbortController().signal }),
    publish: (event: unknown) => { queue.push(event); wake?.() },
    warmsFor: (sessionID: string) => warms.filter((warm) => warm.headers.get("session-id") === sessionID),
  }
}

test("root requests are captured from native HTTP hooks and replayed with zstd and the keepalive suffix", async () => {
  warms.length = 0
  const h = await harness()
  assert.deepEqual([...new Set(h.hooks.filter((hook) => hook.providerID).map((hook) => hook.providerID))].sort(), ["github-copilot", "openai"])
  await h.ordinary("root")
  await sleep(300)
  const replay = h.warmsFor("root")[0]
  assert.ok(replay, "warm replay sent")
  assert.equal(replay.url, CODEX_ENDPOINT)
  assert.equal(replay.headers.get("authorization"), "Bearer test-only")
  assert.equal(replay.headers.get("content-encoding"), "zstd")
  assert.deepEqual((replay.body.input as unknown[]).slice(0, -1), requestBody.input)
  assert.equal(JSON.stringify((replay.body.input as unknown[]).at(-1)).includes(KEEPALIVE), true)
  const status = (await h.rpc("status", { sessionID: "root" })).status
  assert.equal(status.model, "gpt-test", "policy uses the provider API model ID, not the catalog alias")
  assert.ok(status.completed >= 1)
  assert.ok(h.emitted.some((value) => value.sessionID === "root"))
  const log = await readFile(join(stateHome, "opencode", "session-warming", "plugin.log"), "utf8")
  assert.equal(log.includes("test-only"), false)
  assert.equal(log.includes("Delegate a task"), false)
  await h.cleanup?.()
})

test("children, auxiliary kinds and unsupported providers never capture; other activity invalidates", async () => {
  warms.length = 0
  const h = await harness()
  await h.ordinary("child")
  const title = new Request(CODEX_ENDPOINT, { method: "POST", body: JSON.stringify(requestBody), headers: { authorization: "Bearer test-only" } })
  await h.trigger("http.request", { sessionID: "root", agent: "title", model, kind: "title", request: title })
  await sleep(150)
  assert.equal(warms.length, 0)
  await h.ordinary("root")
  await h.trigger("context", { sessionID: "root", agent: "build", model: { providerID: "anthropic", id: "claude" }, system: [], messages: [], options: {}, tools: {} })
  await sleep(150)
  assert.equal(h.warmsFor("root").length, 0)
  assert.equal((await h.rpc("status", { sessionID: "root" })).status.reason, "unsupported-provider")
  await h.cleanup?.()
})

test("GPT-6.x catalog aliases resolve to their API model and remain eligible", async () => {
  warms.length = 0
  const h = await harness()
  await h.ordinary("root", { ref: { providerID: "openai", id: "gpt-6.1-sol-fast", variant: "default" },
    body: { ...requestBody, model: "gpt-6.1-sol" } })
  await sleep(150)
  assert.ok(h.warmsFor("root").length >= 1)
  const status = (await h.rpc("status", { sessionID: "root" })).status
  assert.equal(status.model, "gpt-6.1-sol")
  assert.equal(status.adapterID, "codex")
  await h.cleanup?.()
})

test("session events: errors, compaction, revert and deletion invalidate; interruption keeps the snapshot", async () => {
  warms.length = 0
  const h = await harness()
  for (const [type, reason] of [["session.execution.failed", "session-error"], ["session.compaction.started", "compacting"],
    ["session.revert.staged", "reverted"]] as const) {
    await h.ordinary("root")
    h.publish({ type, data: { sessionID: "root" } })
    await sleep(20)
    assert.equal((await h.rpc("status", { sessionID: "root" })).status.reason, reason, type)
  }
  await h.ordinary("root", { respond: false })
  h.publish({ type: "session.execution.interrupted", data: { sessionID: "root", reason: "user" } })
  await sleep(150)
  assert.ok(h.warmsFor("root").length >= 1, "agent cancellation keeps the validated snapshot replayable")
  h.publish({ type: "session.deleted", data: { sessionID: "root" } })
  await sleep(20)
  const count = h.warmsFor("root").length
  await sleep(150)
  assert.equal(h.warmsFor("root").length, count)
  await h.cleanup?.()
})

test("WebSocket handshakes are reported, and an HTTP fallback request is still captured", async () => {
  warms.length = 0
  const h = await harness()
  await h.trigger("context", { sessionID: "root", agent: "build", model, system: [], messages: [], options: {}, tools: {} })
  await h.trigger("experimental.ws.handshake", { sessionID: "root", agent: "build", model, kind: "primary", url: "wss://x", headers: {} })
  assert.equal((await h.rpc("status", { sessionID: "root" })).status.reason, "websocket-transport")
  const request = new Request(CODEX_ENDPOINT, { method: "POST", body: JSON.stringify(requestBody),
    headers: { authorization: "Bearer test-only", "content-type": "application/json", "session-id": "root" } })
  await h.trigger("http.request", { sessionID: "root", agent: "build", model, kind: "primary", request })
  const event = await h.trigger("http.response", { sessionID: "root", agent: "build", model, kind: "primary", request, response: completedResponse() })
  await (event.response as Response).text()
  await sleep(150)
  assert.ok(h.warmsFor("root").length >= 1)
  await h.cleanup?.()
})

test("RPC controls stop and restart warming without history writes, and validate root eligibility", async () => {
  warms.length = 0
  const h = await harness()
  await h.ordinary("root")
  assert.equal((await h.rpc("control", { requestID: "r1", sessionID: "root", action: "stop" })).result, "stopped")
  assert.equal((await h.rpc("control", { requestID: "r1", sessionID: "root", action: "stop" })).result, "stopped", "duplicate applies once")
  const stopped = h.warmsFor("root").length
  await sleep(150)
  assert.equal(h.warmsFor("root").length, stopped)
  assert.equal((await h.rpc("status", { sessionID: "root" })).status.manualStopped, true)
  assert.equal((await h.rpc("control", { requestID: "r2", sessionID: "root", action: "start" })).result, "started")
  await sleep(150)
  assert.ok(h.warmsFor("root").length > stopped)
  assert.equal((await h.rpc("control", { requestID: "r3", sessionID: "child", action: "stop" })).result, "not-root")
  assert.equal((await h.rpc("control", { requestID: "r4", sessionID: "missing", action: "stop" })).result, "unavailable")
  assert.equal((await h.rpc("control", { requestID: "r5", sessionID: "root", action: "pause" })).result, "unavailable")
  await h.cleanup?.()
})

test("RPC extend lengthens the live window without replacing its capture or writing history", async () => {
  warms.length = 0
  const h = await harness()
  await h.ordinary("root")
  await sleep(100)
  const before = (await h.rpc("status", { sessionID: "root" })).status
  assert.equal((await h.rpc("control", { requestID: "e1", sessionID: "root", action: "extend", durationMs: 300 })).result, "extended")
  assert.equal((await h.rpc("control", { requestID: "e1", sessionID: "root", action: "extend", durationMs: 300 })).result, "extended", "duplicate applies once")
  let status = (await h.rpc("status", { sessionID: "root" })).status
  assert.equal(status.durationMs, 3300)
  assert.equal(status.expiresAt, before.expiresAt + 300)
  assert.equal(status.startedAt, before.startedAt)
  assert.ok(status.completed >= before.completed, "statistics are not reset")
  assert.equal((await h.rpc("control", { requestID: "e2", sessionID: "root", action: "extend" })).result, "extended")
  status = (await h.rpc("status", { sessionID: "root" })).status
  assert.equal(status.durationMs, 6300, "a bare extend adds one configured duration")
  assert.equal((await h.rpc("control", { requestID: "e3", sessionID: "child", action: "extend" })).result, "not-root")
  assert.equal((await h.rpc("control", { requestID: "e4", sessionID: "other", action: "extend" })).result, "awaiting-activity")
  assert.equal((await h.rpc("control", { requestID: "e5", sessionID: "root", action: "start", durationMs: 300 })).result, "unavailable")
  assert.equal((await h.rpc("control", { requestID: "e6", sessionID: "root", action: "extend", durationMs: 0 })).result, "unavailable")
  await h.cleanup?.()
  const log = await readFile(join(stateHome, "opencode", "session-warming", "plugin.log"), "utf8")
  assert.match(log, /warming-extended/)
})

test("native warming configuration suspends every window until it is removed", async () => {
  warms.length = 0
  const h = await harness()
  await h.ordinary("root")
  await h.rpc("native", { enabled: true })
  const status = await h.rpc("status", { sessionID: "root" })
  assert.equal(status.native, true)
  assert.equal(status.status.reason, "native-warming")
  const count = h.warmsFor("root").length
  await h.ordinary("root")
  await sleep(150)
  assert.equal(h.warmsFor("root").length, count)
  assert.equal((await h.rpc("control", { requestID: "n1", sessionID: "root", action: "start" })).result, "native-warming")
  await h.rpc("native", { enabled: false })
  await h.ordinary("root")
  await sleep(150)
  assert.ok(h.warmsFor("root").length > count)
  await h.cleanup?.()
})

test("unsupported versions and invalid options register nothing", async () => {
  for (const [options, app] of [[{}, { name: "opencode", version: "1.18.30", channel: "latest" }],
    [{}, { name: "opencode", version: "2.2.0", channel: "latest" }], [{ bogus: true }, undefined]] as const) {
    const h = await harness(options, app)
    assert.equal(h.hooks.length, 0)
    assert.equal(h.cleanup, undefined)
  }
})

test("capture failures fail open and never alter the ordinary request", async () => {
  warms.length = 0
  const h = await harness()
  await h.trigger("context", { sessionID: "root", agent: "build", model, system: [], messages: [], options: {}, tools: {} })
  const request = new Request(CODEX_ENDPOINT, { method: "POST", body: "not json", headers: { authorization: "Bearer test-only", "content-encoding": "zstd" } })
  const event = await h.trigger("http.request", { sessionID: "root", agent: "build", model, kind: "primary", request })
  assert.equal(event.request, request)
  assert.equal(request.bodyUsed, false)
  assert.equal((await h.rpc("status", { sessionID: "root" })).status.reason, "unsupported-content-encoding")
  await h.cleanup?.()
})
