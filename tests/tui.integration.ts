import assert from "node:assert/strict"
import { test } from "node:test"
import { spawn, spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"
import { StatusPublisher } from "../status.ts"
import type { WarmStatus } from "../status.ts"

test("interactive v1 renders native progress, accepts input and updates request markers", { timeout: 120000 }, async (t) => {
  assert.equal(spawnSync("opencode", ["--version"], { encoding: "utf8" }).stdout.trim(), "1.18.30")
  assert.equal(spawnSync("python3", ["--version"]).status, 0, "Python 3 is required for the PTY smoke test")
  const project = resolve(fileURLToPath(new URL("..", import.meta.url)))
  const home = await mkdtemp(join(tmpdir(), "opencode-warming-tui-"))
  const worktree = join(home, "worktree")
  await mkdir(worktree)
  const config = { autoupdate: false, enabled_providers: ["openai"], mcp: {}, model: "openai/gpt-5.4",
    provider: { openai: { options: { apiKey: "fixture-only", baseURL: "http://127.0.0.1:9/v1", timeout: 500 },
      models: { "gpt-5.4": { name: "UI mock", limit: { context: 200000, output: 8192 } } } } },
    plugin: [[pathToFileURL(join(project, "plugin.ts")).href, { intervalMs: 200, durationMs: 6000 }]] }
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: home, TERM: "xterm-256color", COLORTERM: "truecolor",
    XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"),
    XDG_STATE_HOME: join(home, "state"), OPENCODE_TEST_HOME: home, OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_EXPERIMENTAL_NATIVE_LLM: "false", OPENCODE_EXPERIMENTAL_WEBSOCKETS: "false" }
  let output = ""
  let errors = ""
  let serverOutput = ""
  let url: string | undefined
  let server: ReturnType<typeof spawn> | undefined
  let failure = false
  const publisher = new StatusPublisher(() => {}, join(home, "state", "opencode", "session-warming", "status"))
  const logPath = join(home, "data", "opencode", "log", "opencode.log")
  try {
    const configHome = join(home, "config", "opencode")
    await mkdir(configHome, { recursive: true })
    await writeFile(join(configHome, "tui.json"), JSON.stringify({ plugin: [pathToFileURL(join(project, "tui.tsx")).href] }))
    // Initialize the local server before the UI: no initialization-time SDK calls in a TUI fixture.
    server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: worktree, env, stdio: ["ignore", "pipe", "pipe"] })
    server.stdout!.on("data", (chunk) => {
      serverOutput = (serverOutput + chunk).slice(-16000)
      url = /http:\/\/127\.0\.0\.1:\d+/.exec(serverOutput)?.[0]
    })
    server.stderr!.on("data", (chunk) => { serverOutput = (serverOutput + chunk).slice(-16000) })
    async function waitFor(check: () => Promise<boolean>, description: string, timeout = 45000) {
      const until = Date.now() + timeout
      let error: unknown
      while (Date.now() < until && !t.signal.aborted) {
        try { if (await check()) return } catch (value) { error = value }
        if (server!.exitCode !== null || server!.signalCode !== null) break
        await sleep(50)
      }
      throw new Error(`Timed out waiting for ${description}: ${String(error)}\n${serverOutput}`)
    }
    async function api(path: string, body?: unknown) {
      const response = await fetch(url! + path, { method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", "x-opencode-directory": worktree },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([AbortSignal.timeout(path === "/global/health" ? 2000 : 45000), t.signal]) })
      assert.ok(response.ok, `${path}: HTTP ${response.status}`)
      return response.json() as Promise<Record<string, unknown>>
    }
    await waitFor(async () => !!url && (await api("/global/health")).version === "1.18.30", "server health")
    const session = await api("/session", { title: "Warming UI fixture" })
    const startedAt = Date.now() - 16 * 60000
    const status: WarmStatus = { sessionID: String(session.id), phase: "waiting", startedAt,
      expiresAt: startedAt + 3600000, intervalMs: 240000, durationMs: 3600000,
      nextAttemptAt: Date.now() + 30000, attempted: 3, completed: 3, failed: 0,
      marks: [4, 8, 12].map((minutes) => ({ at: startedAt + minutes * 60000 + 10, result: "completed" })) }
    publisher.publish(status)
    await publisher.flush()
    const child = spawn("python3", [join(project, "tests", "tui_driver.py"), worktree, url!, status.sessionID], {
      signal: t.signal, env: { ...env, WARMING_TUI_EXPECT_INDICATOR: "1" }, stdio: ["ignore", "pipe", "pipe"],
    })
    child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-32000) })
    child.stderr.on("data", (chunk) => { errors = (errors + chunk).slice(-16000) })
    const closed = new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done) })
    await waitFor(async () => /\[session-warming\] ui-ready/.test(await readFile(logPath, "utf8")), "UI initialization")
    await sleep(1500)
    status.phase = "sending"
    status.attempted = 4
    status.marks.push({ at: Date.now(), result: "sending" })
    publisher.publish(status)
    await publisher.flush()
    await sleep(2500)
    status.phase = "waiting"
    status.failed = 1
    status.marks.at(-1)!.result = "failed"
    status.nextAttemptAt = Date.now() + 30000
    publisher.publish(status)
    await publisher.flush()
    const code = await closed
    const logs = await readFile(logPath, "utf8").catch(() => "")
    assert.equal(code, 0, `TUI startup failed\n${output}\n${errors}\n${logs}`)
    const result = JSON.parse(output)
    assert.equal(result.screenReady, true)
    assert.equal(result.inputResponsive, true)
    assert.equal(result.indicatorCompleted, true, `Completed markers missing\n${result.output}`)
    assert.equal(result.indicatorSending, true, `In-flight marker missing\n${result.output}`)
    assert.equal(result.indicatorFailed, true, `Failed marker missing\n${result.output}`)
    assert.doesNotMatch(logs, /warm-started|warm-completed|initialization-failed/)
    assert.doesNotMatch(result.output, /failed to load tui plugin|Cannot find module/)
  } catch (error) { failure = true; throw error }
  finally {
    await publisher.dispose()
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = new Promise<void>((done) => server!.once("exit", () => done()))
      server.kill("SIGTERM")
      await Promise.race([exited, sleep(3000)])
      if (server.exitCode === null && server.signalCode === null) { server.kill("SIGKILL"); await exited }
    }
    if (failure && process.env.WARMING_KEEP_TEST === "1") console.error(`Kept isolated TUI test artifacts: ${home}`)
    else await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
