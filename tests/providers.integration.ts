import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer } from "node:http"
import type { ServerResponse } from "node:http"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { spawn, spawnSync } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"
import { CAPTURE_HEADER } from "../protocol.ts"
import { readStatus } from "../status.ts"
import { isSupportedOpenCodeVersion } from "../compatibility.ts"
import { imageURL } from "./helpers.ts"

const targets = [
  { providerID: "openai", modelID: "gpt-5.6-sol", messages: false },
  { providerID: "github-copilot", modelID: "gpt-5.6-sol", messages: false },
  { providerID: "github-copilot", modelID: "claude-sonnet-5", messages: true },
  { providerID: "github-copilot", modelID: "claude-opus-5", messages: true },
]
const event = (type: string, fields: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`

function respond(res: ServerResponse, model: string, messages: boolean, task = false, prewarm = false) {
  const args = JSON.stringify({ description: "slow child", prompt: "adapter-child: return the result", subagent_type: "slow-child" })
  const usage = messages ? { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 0, output_tokens: 1 } :
    { input_tokens: 100, input_tokens_details: { cached_tokens: 90, cache_write_tokens: 10 }, output_tokens: prewarm ? 0 : 1 }
  if (prewarm) {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ id: "prewarm", object: "response", status: "completed", model, output: [], usage }))
    return
  }
  res.writeHead(200, { "content-type": "text/event-stream" })
  if (messages) {
    res.write(event("message_start", { message: { id: "msg_test", type: "message", role: "assistant", content: [], model,
      stop_reason: null, stop_sequence: null, usage } }))
    res.write(event("content_block_start", { index: 0, content_block: task ? { type: "tool_use", id: "call_test", name: "task", input: {} } : { type: "text", text: "" } }))
    res.write(event("content_block_delta", { index: 0, delta: task ? { type: "input_json_delta", partial_json: args } : { type: "text_delta", text: "mock answer" } }))
    res.write(event("content_block_stop", { index: 0 }))
    res.write(event("message_delta", { delta: { stop_reason: task ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }))
    res.end(event("message_stop", {}))
    return
  }
  const item = task ? { id: "fc_test", type: "function_call", call_id: "call_test", name: "task", arguments: args, status: "completed" } :
    { id: "msg_test", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "mock answer", annotations: [] }] }
  const response = { id: "resp_test", object: "response", created_at: 1, status: "completed", model, output: [item], usage }
  res.write(event("response.created", { response: { ...response, status: "in_progress", output: [] } }))
  res.write(event("response.output_item.added", { output_index: 0, item: { ...item, arguments: task ? "" : undefined, content: task ? undefined : [] } }))
  if (task) {
    res.write(event("response.function_call_arguments.delta", { item_id: item.id, output_index: 0, delta: args }))
    res.write(event("response.function_call_arguments.done", { item_id: item.id, output_index: 0, arguments: args }))
  } else {
    res.write(event("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }))
    res.write(event("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: "mock answer" }))
    res.write(event("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: "mock answer" }))
  }
  res.write(event("response.output_item.done", { output_index: 0, item }))
  res.end(event("response.completed", { response }))
}

test("installed v1 preserves authenticated OpenAI/Copilot prefixes while warming blocked roots", { timeout: 120000 }, async (t) => {
  assert.ok(isSupportedOpenCodeVersion(spawnSync("opencode", ["--version"], { encoding: "utf8" }).stdout.trim()))
  const home = await mkdtemp(join(tmpdir(), "warming-adapters-runtime-"))
  const project = resolve(import.meta.dirname, "..")
  const requests: { session: string; warm: boolean; body: Record<string, any>; provider: string }[] = []
  const parents = new Set<string>()
  const delegated = new Set<string>()
  const tools: string[] = []
  const idle: string[] = []
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let logs = ""
  let child: ReturnType<typeof spawn> | undefined
  const backend = createServer(async (req, res) => {
    try {
      let text = ""
      for await (const chunk of req) text += chunk
      if (req.url === "/models") {
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ data: targets.filter((target) => target.providerID === "github-copilot").map((target) => ({
          id: target.modelID, name: target.modelID, version: `${target.modelID}-2026-09-01`, model_picker_enabled: true,
          supported_endpoints: [target.messages ? "/v1/messages" : "/responses"], policy: { state: "enabled" },
          capabilities: { family: target.messages ? "claude" : "gpt", limits: { max_context_window_tokens: 200000, max_prompt_tokens: 190000, max_output_tokens: 8192 },
            supports: { tool_calls: true, streaming: true, vision: true, reasoning_effort: target.messages ? ["low", "medium", "high"] : ["medium"] } },
        })) }))
        return
      }
      const body = JSON.parse(text)
      if (req.url === "/tool") { tools.push(body.tool); res.end("ok"); return }
      if (req.url === "/idle") { idle.push(body.sessionID); res.end("ok"); return }
      const session = String(req.headers["x-fixture-session"])
      const provider = req.url!.startsWith("/openai/") ? "openai" : "github-copilot"
      const messages = req.url!.endsWith("/messages")
      const warm = body.prompt_cache_options?.prewarm === true || body.max_output_tokens === 128 || body.max_tokens === 128
      assert.equal(req.headers.authorization, "Bearer integration-only")
      assert.equal(req.headers[CAPTURE_HEADER], undefined)
      if (provider === "github-copilot") {
        assert.equal(req.headers["x-github-api-version"], "2026-06-01")
        assert.equal(req.headers["x-interaction-id"], session)
        if (warm) assert.equal(req.headers["x-initiator"], "agent")
      }
      requests.push({ session, warm, body, provider })
      if (warm) {
        // Return a local tool call for Claude warming. It must never be dispatched.
        respond(res, body.model, messages, messages, body.prompt_cache_options?.prewarm === true)
        return
      }
      if (parents.has(session) && !delegated.has(session) && body.tools?.some((tool: { name: string }) => tool.name === "task")) {
        delegated.add(session); respond(res, body.model, messages, true); return
      }
      if (!parents.has(session) && text.includes("adapter-child:")) {
        const timer = setTimeout(() => { timers.delete(timer); if (!res.destroyed) respond(res, body.model, messages) }, 1400)
        timers.add(timer)
        res.on("close", () => { clearTimeout(timer); timers.delete(timer) })
        return
      }
      respond(res, body.model, messages)
    } catch (error) {
      logs += `\nMock failure: ${String(error)}`
      if (!res.headersSent) res.writeHead(500)
      res.end("mock failure")
    }
  })
  await new Promise<void>((done) => backend.listen(0, "127.0.0.1", done))
  const backendPort = (backend.address() as { port: number }).port
  const reservation = createServer()
  await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done))
  const port = (reservation.address() as { port: number }).port
  await new Promise<void>((done) => reservation.close(() => done()))
  try {
    const worktree = join(home, "worktree")
    const configHome = join(home, "config", "opencode")
    const dataHome = join(home, "data", "opencode")
    await Promise.all([mkdir(worktree), mkdir(configHome, { recursive: true }), mkdir(dataHome, { recursive: true })])
    await writeFile(join(dataHome, "auth.json"), JSON.stringify({ openai: { type: "api", key: "integration-only" },
      "github-copilot": { type: "oauth", access: "integration-only", refresh: "integration-only", expires: 0 } }))
    const fixture = join(home, "fixture.ts")
    await writeFile(fixture, `export default async () => {
      const original = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if(url.protocol === "data:" || url.hostname === "127.0.0.1" || url.hostname === "localhost") return original(input, init);
        if(url.hostname === "api.openai.com") return original("http://127.0.0.1:${backendPort}/openai" + url.pathname, init);
        if(url.hostname === "api.githubcopilot.com") return original("http://127.0.0.1:${backendPort}" + url.pathname, init);
        throw new Error("External network disabled by fixture");
      };
      return {
        "chat.headers": async (input, output) => { output.headers["x-fixture-session"] = input.sessionID; },
        event: async ({event}) => { if(event.type === "session.idle") await fetch("http://127.0.0.1:${backendPort}/idle", {method:"POST",body:JSON.stringify(event.properties)}); },
        "tool.execute.before": async ({tool}) => { await fetch("http://127.0.0.1:${backendPort}/tool", {method:"POST",body:JSON.stringify({tool})}); }
      };
    };`)
    const config = { autoupdate: false, enabled_providers: ["openai", "github-copilot"], model: "openai/gpt-5.6-sol", small_model: "openai/gpt-5.6-sol",
      compaction: { auto: false, prune: false }, plugin: [pathToFileURL(fixture).href,
        [pathToFileURL(join(project, "plugin.ts")).href, { intervalMs: 200, durationMs: 6000, debug: true }]],
      provider: { openai: { models: { "gpt-5.6-sol": { name: "Mock GPT", limit: { context: 200000, output: 8192 } } } },
        "github-copilot": { models: Object.fromEntries(targets.filter((target) => target.providerID === "github-copilot").map((target) => [target.modelID,
          { name: target.modelID, limit: { context: 200000, output: 8192 } }])) } },
      agent: { "slow-child": { mode: "subagent", description: "Mock slow child", prompt: "Return the mock result without tools" } } }
    child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"], { cwd: worktree,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
        XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), OPENCODE_TEST_HOME: home,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_EXPERIMENTAL_NATIVE_LLM: "false", OPENCODE_EXPERIMENTAL_WEBSOCKETS: "false" }, stdio: ["ignore", "pipe", "pipe"] })
    child.stdout!.on("data", (chunk) => { logs = (logs + chunk).slice(-24000) })
    child.stderr!.on("data", (chunk) => { logs = (logs + chunk).slice(-24000) })
    const base = `http://127.0.0.1:${port}`
    const api = async (path: string, body?: unknown, timeout = 45000): Promise<any> => {
      const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-opencode-directory": worktree },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(timeout), t.signal]) })
      assert.ok(response.ok, `${path}: ${response.status}`)
      return response.json()
    }
    const wait = async (check: () => boolean | Promise<boolean>, description: string) => {
      const end = Date.now() + 45000
      while (Date.now() < end) {
        if (child!.exitCode !== null) throw new Error(`server exited: ${logs}`)
        try { if (await check()) return } catch { /* startup and publication are asynchronous */ }
        await sleep(50)
      }
      throw new Error(`Timed out: ${description}\n${logs}`)
    }
    await wait(async () => isSupportedOpenCodeVersion((await api("/global/health", undefined, 2000)).version), "health")
    for (const target of targets) {
      const session = String((await api("/session", { title: `adapter ${target.modelID}` })).id)
      parents.add(session)
      const prompt = api(`/session/${session}/message`, { model: { providerID: target.providerID, modelID: target.modelID }, parts: [{ type: "text", text: "adapter-parent: delegate to slow-child and wait" },
        { type: "file", mime: "image/png", filename: "screenshot.png", url: imageURL }] })
      await wait(() => requests.some((request) => request.session === session && request.warm), `${target.providerID}/${target.modelID} warming`)
      const ordinary = requests.find((request) => request.session === session && !request.warm)!.body
      const warm = requests.find((request) => request.session === session && request.warm)!.body
      assert.deepEqual(warm[target.messages ? "messages" : "input"], ordinary[target.messages ? "messages" : "input"])
      assert.deepEqual(warm.tools, ordinary.tools)
      assert.deepEqual(warm.system, ordinary.system)
      assert.deepEqual(warm.thinking, ordinary.thinking)
      if (target.messages) assert.deepEqual(warm.tool_choice, ordinary.tool_choice)
      assert.ok(JSON.stringify(ordinary).includes(imageURL.split(",")[1]), "attachment must be serialized and preserved")
      assert.equal((await api("/session/status"))[session].type, "busy")
      assert.equal(idle.includes(session), false)
      const before = tools.filter((tool) => tool === "task").length
      await prompt
      const history = await api(`/session/${session}/message`)
      assert.equal(history.filter((entry: any) => entry.info.role === "user").length, 1)
      await wait(() => requests.some((request) => request.session === session && request.warm &&
        JSON.stringify(request.body[target.messages ? "messages" : "input"]).includes(target.messages ? "tool_result" : "function_call_output")), "tool continuation warming")
      assert.equal(tools.filter((tool) => tool === "task").length, before, "warm-generated tool calls must not execute")
      const directory = join(home, "state", "opencode", "session-warming", "status")
      await wait(async () => ((await readStatus(session, directory)).status?.completed ?? 0) > 0, "completed status")
      assert.equal((await readStatus(session, directory)).status?.providerID, target.providerID)
      delegated.delete(session)
      const previous = requests.filter((request) => request.session === session && request.warm).length
      const cancelledPrompt = api(`/session/${session}/message`, { model: { providerID: target.providerID, modelID: target.modelID },
        parts: [{ type: "text", text: "adapter-parent: delegate again and wait" }] }).catch(() => undefined)
      await wait(() => requests.filter((request) => request.session === session && request.warm).length > previous, "warming before cancellation")
      await api(`/session/${session}/abort`, {})
      await cancelledPrompt
      const count = requests.filter((request) => request.session === session && request.warm).length
      await sleep(450)
      assert.equal(requests.filter((request) => request.session === session && request.warm).length, count)
    }
    assert.ok(requests.filter((request) => !parents.has(request.session)).every((request) => !request.warm), "children never warm")
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM")
      await Promise.race([new Promise<void>((done) => child!.once("exit", () => done())), sleep(3000)])
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((done) => child!.once("exit", () => done()))
        child.kill("SIGKILL"); await exited
      }
    }
    for (const timer of timers) clearTimeout(timer)
    backend.closeAllConnections()
    await new Promise<void>((done) => backend.close(() => done()))
    await rm(home, { recursive: true, force: true })
  }
})
