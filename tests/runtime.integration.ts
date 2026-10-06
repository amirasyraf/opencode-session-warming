import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer } from "node:http"
import type { ServerResponse } from "node:http"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawn, spawnSync } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"
import { CAPTURE_HEADER, KEEPALIVE } from "../protocol.ts"

const project = resolve(fileURLToPath(new URL("..", import.meta.url)))
const encoder = (type: string, fields: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`

function sendResponse(res: ServerResponse, output: unknown[], id: string, call = false) {
  const response = { id, object: "response", created_at: 1, status: "completed", model: "gpt-5.4", output,
    usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 90 }, output_tokens: 1 } }
  res.writeHead(200, { "content-type": "text/event-stream" })
  res.write(encoder("response.created", { response: { ...response, status: "in_progress", output: [] } }))
  const item = output[0] as Record<string, unknown>
  res.write(encoder("response.output_item.added", { output_index: 0, item: { ...item, arguments: call ? "" : undefined, content: call ? undefined : [] } }))
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

test("installed v1 warms blocked parents, preserves OAuth, and stops on cancellation", { timeout: 120000 }, async (t) => {
  const version = spawnSync("opencode", ["--version"], { encoding: "utf8" })
  assert.equal(version.status, 0, "opencode must be available")
  assert.equal(version.stdout.trim(), "1.18.30", "runtime integration is version-pinned")
  const home = await mkdtemp(join(tmpdir(), "opencode-warming-test-"))
  const requests: { session: string; warm: boolean; marker: boolean; auth: boolean; at: number }[] = []
  const notifications: string[] = []
  const tools: string[] = []
  const parents = new Set<string>()
  const delegated = new Set<string>()
  const childTimers = new Set<ReturnType<typeof setTimeout>>()
  let processLogs = ""
  const backend = createServer(async (req, res) => {
    try {
      let text = ""
      for await (const chunk of req) text += chunk
      if (req.url === "/idle") { notifications.push(JSON.parse(text).sessionID); res.end("ok"); return }
      if (req.url === "/tool") { tools.push(JSON.parse(text).tool); res.end("ok"); return }
      const body = JSON.parse(text)
      const session = String(req.headers["session-id"] ?? req.headers["x-session-id"])
      const warm = JSON.stringify(body.input.at(-1)).includes(KEEPALIVE)
      requests.push({ session, warm, marker: CAPTURE_HEADER in req.headers, auth: req.headers.authorization === "Bearer integration-only", at: Date.now() })
      const id = `resp_${requests.length}`
      if (warm) { sendResponse(res, message("OK", `msg_${id}`), id); return }
      const hasTask = body.tools?.some((tool: { name: string }) => tool.name === "task")
      if (parents.has(session) && hasTask && !delegated.has(session)) {
        delegated.add(session)
        sendResponse(res, [{ id: `fc_${id}`, type: "function_call", name: "task", call_id: `call_${id}`,
          arguments: JSON.stringify({ description: "slow child", prompt: "integration-child: return the result", subagent_type: "slow-child" }),
          status: "completed" }], id, true)
      } else if (!parents.has(session) && JSON.stringify(body.input).includes("integration-child")) {
        // Keep child generation open while the parent is blocked on its foreground task.
        const timer = setTimeout(() => { childTimers.delete(timer); if (!res.destroyed) sendResponse(res, message("child done", `msg_${id}`), id) }, 1800)
        childTimers.add(timer)
        res.on("close", () => { clearTimeout(timer); childTimers.delete(timer) })
      } else sendResponse(res, message("parent done", `msg_${id}`), id)
    } catch { res.writeHead(500); res.end("mock failure") }
  })
  await new Promise<void>((done) => backend.listen(0, "127.0.0.1", done))
  const backendPort = (backend.address() as { port: number }).port
  const temporary = createServer()
  await new Promise<void>((done) => temporary.listen(0, "127.0.0.1", done))
  const port = (temporary.address() as { port: number }).port
  await new Promise<void>((done) => temporary.close(() => done()))
  let child: ReturnType<typeof spawn> | undefined
  try {
    const configHome = join(home, "config", "opencode")
    const dataHome = join(home, "data", "opencode")
    const worktree = join(home, "worktree")
    await Promise.all([mkdir(configHome, { recursive: true }), mkdir(dataHome, { recursive: true }), mkdir(worktree)])
    await writeFile(join(dataHome, "auth.json"), JSON.stringify({ openai: {
      type: "oauth", access: "integration-only", refresh: "never-use-this", expires: Date.now() + 3600000, accountId: "integration",
    } }))
    const fixture = join(home, "fixture.ts")
    // A test-only transport maps the genuine Codex URL to a local mock, before capture installs.
    await writeFile(fixture, `export default async () => {
      const original = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.href === "https://chatgpt.com/backend-api/codex/responses")
          return original("http://127.0.0.1:${backendPort}/responses", init);
        if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return original(input, init);
        throw new Error("External network disabled by integration fixture");
      };
      return {
        event: async ({event}) => { if(event.type === "session.idle")
          await fetch("http://127.0.0.1:${backendPort}/idle", {method:"POST", body:JSON.stringify(event.properties)}); },
        "tool.execute.before": async ({tool}) => {
          await fetch("http://127.0.0.1:${backendPort}/tool", {method:"POST", body:JSON.stringify({tool})}); }
      };
    };`)
    const config = {
      autoupdate: false, enabled_providers: ["openai"], model: "openai/gpt-5.4", small_model: "openai/gpt-5.4",
      compaction: { auto: false, prune: false },
      plugin: [pathToFileURL(fixture).href, [pathToFileURL(join(project, "plugin.ts")).href, { intervalMs: 200, durationMs: 6000 }]],
      provider: { openai: { models: { "gpt-5.4": { name: "Mock Codex", limit: { context: 200000, output: 8192 } } } } },
      agent: { "slow-child": { mode: "subagent", description: "Integration slow child", prompt: "Return the mock result without tools" } },
    }
    child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"], {
      cwd: worktree,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, XDG_CONFIG_HOME: join(home, "config"),
        XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
        OPENCODE_TEST_HOME: home, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_EXPERIMENTAL_NATIVE_LLM: "false", OPENCODE_EXPERIMENTAL_WEBSOCKETS: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    child.stdout!.on("data", (chunk) => { processLogs = (processLogs + chunk).slice(-16000) })
    child.stderr!.on("data", (chunk) => { processLogs = (processLogs + chunk).slice(-16000) })
    const base = `http://127.0.0.1:${port}`
    async function api(path: string, body?: unknown) {
      const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", "x-opencode-directory": worktree },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(45000), t.signal]) })
      assert.ok(response.ok, `${path}: HTTP ${response.status}: ${await (response.ok ? Promise.resolve("") : response.text())}`)
      return response.json() as Promise<Record<string, unknown>>
    }
    async function waitFor(check: () => boolean | Promise<boolean>, description: string, timeout = 45000) {
      const end = Date.now() + timeout
      while (Date.now() < end) {
        if (child!.exitCode !== null) throw new Error(`OpenCode exited: ${processLogs}`)
        try { if (await check()) return } catch (error) { if (child!.exitCode !== null) throw error }
        await sleep(50)
      }
      throw new Error(`Timed out waiting for ${description}\n${processLogs}`)
    }
    await waitFor(async () => (await api("/global/health")).version === "1.18.30", "server health")
    const session = await api("/session", { title: "warming integration" })
    const id = String(session.id)
    parents.add(id)
    const prompt = api(`/session/${id}/message`, { model: { providerID: "openai", modelID: "gpt-5.4" },
      parts: [{ type: "text", text: "integration-parent: delegate to slow-child and wait" }] })
    await waitFor(() => requests.some((request) => request.session === id && request.warm), "parent warming during foreground task")
    const status = await api("/session/status")
    assert.equal((status[id] as { type: string }).type, "busy")
    assert.equal(notifications.includes(id), false, "warming must not emit idle/task-completion events")
    assert.equal(tools.filter((tool) => tool === "task").length, 1)
    await prompt
    const messages = await api(`/session/${id}/message`) as unknown as { info: { role: string }; parts: { type: string; text?: string }[] }[]
    assert.equal(messages.filter((entry) => entry.info.role === "user").length, 1)
    assert.equal(JSON.stringify(messages).includes(KEEPALIVE), false)
    assert.equal(messages.some((entry) => entry.parts.some((part) => part.type === "text" && part.text === "OK")), false)
    assert.ok(requests.every((request) => !request.marker && request.auth))
    const childSessions = requests.filter((request) => request.session !== id)
    assert.ok(childSessions.length > 0)
    assert.ok(childSessions.every((request) => !request.warm))

    const cancelled = await api("/session", { title: "cancellation integration" })
    const cancelledID = String(cancelled.id)
    parents.add(cancelledID)
    const cancelledPrompt = api(`/session/${cancelledID}/message`, { model: { providerID: "openai", modelID: "gpt-5.4" },
      parts: [{ type: "text", text: "integration-parent: delegate to slow-child and wait" }] }).catch(() => undefined)
    await waitFor(() => requests.some((request) => request.session === cancelledID && request.warm), "second parent warming")
    await api(`/session/${cancelledID}/abort`, {})
    await cancelledPrompt
    const before = requests.filter((request) => request.session === cancelledID && request.warm).length
    await sleep(600)
    assert.equal(requests.filter((request) => request.session === cancelledID && request.warm).length, before)
  } catch (error) {
    throw new Error(`Runtime integration failed: ${String(error)}\n${processLogs}`, { cause: error })
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM")
      await Promise.race([new Promise<void>((done) => child!.once("exit", () => done())), sleep(3000)])
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((done) => child!.once("exit", () => done()))
        child.kill("SIGKILL")
        await exited
      }
    }
    for (const timer of childTimers) clearTimeout(timer)
    backend.closeAllConnections()
    await new Promise<void>((done) => backend.close(() => done()))
    await rm(home, { recursive: true, force: true })
  }
})
