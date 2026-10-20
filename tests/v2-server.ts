import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { ServerResponse } from "node:http"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, spawnSync } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"
import { zstdDecompressSync } from "node:zlib"
import { KEEPALIVE } from "../protocol.ts"
import { isSupportedOpenCodeVersion } from "../compatibility.ts"

/** Shared, fully isolated OpenCode V2 server harness for runtime and TUI integration tests. */
export const project = resolve(fileURLToPath(new URL("..", import.meta.url)))
export const binary = process.env.OPENCODE_BIN
const encoder = (type: string, fields: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`

function sendResponse(res: ServerResponse, output: Record<string, unknown>[], id: string, model: string, call = false) {
  const response = { id, object: "response", created_at: 1, status: "completed", model, output,
    usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 90 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 101 } }
  res.writeHead(200, { "content-type": "text/event-stream" })
  res.write(encoder("response.created", { response: { ...response, status: "in_progress", output: [] } }))
  const item = output[0]
  res.write(encoder("response.output_item.added", { output_index: 0, item: call ? { ...item, arguments: "" } : { ...item, content: [] } }))
  if (call) {
    res.write(encoder("response.function_call_arguments.delta", { item_id: item.id, output_index: 0, delta: item.arguments }))
    res.write(encoder("response.function_call_arguments.done", { item_id: item.id, output_index: 0, arguments: item.arguments }))
  } else {
    const content = (item.content as Record<string, unknown>[])[0]
    res.write(encoder("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { ...content, text: "" } }))
    res.write(encoder("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: content.text }))
    res.write(encoder("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: content.text }))
  }
  res.write(encoder("response.output_item.done", { output_index: 0, item }))
  res.end(encoder("response.completed", { response }))
}
const message = (text: string, id: string) => [{ id, type: "message", role: "assistant", status: "completed",
  content: [{ type: "output_text", text, annotations: [] }] }]

// Test-only plugin: maps the genuine Codex URL to the local mock and refuses every other external host.
// It is listed after the warming plugin, so warming observes the genuine ordinary request first.
const fixture = (mock: string) => `
const MOCK = ${JSON.stringify(mock)}
const CODEX = "https://chatgpt.com/backend-api/codex/responses"
const original = globalThis.fetch
const local = (url) => url.protocol === "data:" || url.hostname === "127.0.0.1" || url.hostname === "localhost"
const guard = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.href === CODEX) return original(MOCK, input instanceof Request ? new Request(MOCK, input) : init)
  if (local(url)) return original(input, init)
  return Promise.reject(new Error("External network disabled by integration fixture"))
}
Object.assign(guard, original)
globalThis.fetch = guard
export default {
  id: "warming-integration-fixture",
  async setup(ctx) {
    for (const providerID of ["openai", "github-copilot"]) await ctx.session.hook("http.request", (event) => {
      const url = new URL(event.request.url)
      if (url.href === CODEX) event.request = new Request(MOCK, event.request)
      else if (!local(url)) throw new Error("External network disabled by integration fixture")
    }, { providerID })
  },
}
`


export type MockRequest = { session: string; warm: boolean; auth: boolean; encoding?: string; at: number; input: unknown[] }
export const PASSWORD = "integration-password"

export async function startServer(signal: AbortSignal, options: { plugin?: Record<string, unknown>; cli?: unknown; childDelayMs?: number } = {}) {
  assert.ok(binary, "set OPENCODE_BIN to a private OpenCode V2 2.1.x binary")
  const version = spawnSync(binary, ["--version"], { encoding: "utf8" })
  assert.equal(isSupportedOpenCodeVersion(version.stdout.trim().replace(/^opencode v/, "")), true, `integration requires 2.1.x: ${version.stdout}`)
  const home = await mkdtemp(join(tmpdir(), "opencode-warming-v2-"))
  const requests: MockRequest[] = []
  const parents = new Set<string>()
  const delegated = new Set<string>()
  const childTimers = new Set<ReturnType<typeof setTimeout>>()
  const logs = { text: "" }
  const backend = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      let raw = Buffer.concat(chunks)
      if (req.headers["content-encoding"] === "zstd") raw = zstdDecompressSync(raw)
      const body = JSON.parse(raw.toString("utf8"))
      const session = String(req.headers["x-opencode-session-id"])
      const warm = JSON.stringify(body.input.at(-1)).includes(KEEPALIVE)
      requests.push({ session, warm, auth: req.headers.authorization === "Bearer integration-only",
        encoding: req.headers["content-encoding"] as string | undefined, at: Date.now(), input: body.input })
      const id = `resp_${requests.length}`
      if (warm) { sendResponse(res, message("OK", `msg_${id}`), id, body.model); return }
      const hasSubagent = body.tools?.some((tool: { name?: string }) => tool.name === "subagent")
      if (parents.has(session) && hasSubagent && !delegated.has(session)) {
        delegated.add(session)
        sendResponse(res, [{ id: `fc_${id}`, type: "function_call", name: "subagent", call_id: `call_${id}`, status: "completed",
          arguments: JSON.stringify({ agent: "explore", description: "slow child", prompt: "integration-child: return the result" }) }], id, body.model, true)
      } else if (!parents.has(session) && JSON.stringify(body.input).includes("integration-child")) {
        // Keep the child open so the root stays blocked on its foreground subagent.
        const timer = setTimeout(() => { childTimers.delete(timer); if (!res.destroyed) sendResponse(res, message("child done", `msg_${id}`), id, body.model) },
          options.childDelayMs ?? 2500)
        childTimers.add(timer)
        res.on("close", () => { clearTimeout(timer); childTimers.delete(timer) })
      } else sendResponse(res, message("parent done", `msg_${id}`), id, body.model)
    } catch { res.writeHead(500); res.end("mock failure") }
  })
  await new Promise<void>((done) => backend.listen(0, "127.0.0.1", done))
  const mock = `http://127.0.0.1:${(backend.address() as { port: number }).port}/responses`
  const probe = createServer()
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done))
  const port = (probe.address() as { port: number }).port
  await new Promise<void>((done) => probe.close(() => done()))
  const configDir = join(home, "opencode-config")
  const fixtureDir = join(home, "fixture")
  const worktree = join(home, "worktree")
  await Promise.all([mkdir(configDir, { recursive: true }), mkdir(fixtureDir), mkdir(worktree)])
  await writeFile(join(fixtureDir, "server.js"), fixture(mock))
  await writeFile(join(configDir, "opencode.jsonc"), JSON.stringify({
    autoupdate: false, model: "openai/gpt-6.1-sol",
    plugins: [{ package: project, options: { intervalMs: 300, durationMs: 6000, debug: true, ...options.plugin } }, fixtureDir],
    providers: { openai: { settings: { transport: "http" } } },
  }))
  if (options.cli !== undefined) await writeFile(join(configDir, "cli.json"), JSON.stringify(options.cli))
  const env: Record<string, string> = { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: home, XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
    OPENCODE_CONFIG_DIR: configDir, OPENCODE_DB: join(home, "data", "opencode.db"), OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_SERVER_PASSWORD: PASSWORD,
    // Any request escaping both fixture layers fails at a dead local proxy instead of reaching the network.
    HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost" }
  const child = spawn(binary!, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: worktree, env, stdio: ["ignore", "pipe", "pipe"] })
  child.stdout!.on("data", (chunk) => { logs.text = (logs.text + chunk).slice(-16000) })
  child.stderr!.on("data", (chunk) => { logs.text = (logs.text + chunk).slice(-16000) })
  const base = `http://127.0.0.1:${port}`
  const authorization = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`
  const location = `location[directory]=${encodeURIComponent(worktree)}`
  async function api(method: string, path: string, body?: unknown, timeoutMs = 30000) {
    const response = await fetch(base + path, { method, headers: { authorization, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) })
    const text = await response.text()
    assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}: ${text}`)
    return text ? JSON.parse(text) : {}
  }
  async function waitFor(check: () => boolean | Promise<boolean>, description: string, timeout = 45000) {
    const end = Date.now() + timeout
    let lastError: unknown
    while (Date.now() < end) {
      if (child.exitCode !== null) throw new Error(`OpenCode exited: ${logs.text}`)
      try { if (await check()) return } catch (error) { lastError = error }
      await sleep(50)
    }
    throw new Error(`Timed out waiting for ${description}: ${String(lastError)}`, { cause: lastError })
  }
  const rpc = (method: string, input: unknown) => api("POST", `/api/rpc/session-warming/${method}?${location}`, { input }).then((value) => value.output)
  async function stop() {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM")
      await Promise.race([new Promise<void>((done) => child.once("exit", () => done())), sleep(3000)])
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    }
    for (const timer of childTimers) clearTimeout(timer)
    backend.closeAllConnections()
    await new Promise<void>((done) => backend.close(() => done()))
    await rm(home, { recursive: true, force: true })
  }
  try {
    await waitFor(async () => !!(await api("GET", "/api/info", undefined, 2000)).version, "server health")
    await waitFor(async () => {
      const plugins = (await api("GET", `/api/plugin?${location}`)).data as { id?: string; state: { status: string } }[]
      return ["session-warming", "warming-integration-fixture"].every((id) => plugins.some((plugin) => plugin.id === id && plugin.state.status === "active"))
    }, "warming and fixture plugins active")
    // A fake, isolated ChatGPT OAuth credential: it is only ever presented to the local mock.
    await api("POST", "/api/credential", { integrationID: "openai", label: "integration", activate: true, value: { type: "oauth",
      methodID: "chatgpt-browser", refresh: "never-use-this", access: "integration-only", expires: Date.now() + 86_400_000, metadata: { accountID: "integration" } } })
    await sleep(500)
  } catch (error) { const text = logs.text; await stop(); throw new Error(`${String(error)}\n${text}`, { cause: error }) }
  async function rootSession(title: string) {
    const id = String((await api("POST", "/api/session", { title, location: { directory: worktree },
      model: { providerID: "openai", id: "gpt-6.1-sol" } })).data.id)
    parents.add(id)
    return id
  }
  return { home, worktree, base, env, logs, requests, api, rpc, waitFor, rootSession, stop,
    warms: (id: string) => requests.filter((request) => request.session === id && request.warm) }
}
