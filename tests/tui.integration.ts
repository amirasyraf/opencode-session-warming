import assert from "node:assert/strict"
import { test } from "node:test"
import { spawn, spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { binary, project, startServer } from "./v2-server.ts"

test("OpenCode V2 TUI renders warming status and consumes /warming controls locally", { timeout: 240000 }, async (t) => {
  assert.equal(spawnSync("python3", ["--version"]).status, 0, "Python 3 is required for the PTY test")
  const server = await startServer(t.signal, {
    childDelayMs: 1500,
    cli: { plugins: [{ package: project, options: { color: true, showNextTimer: true, showRemainingTimer: true } }] },
    plugin: { durationMs: 600000, intervalMs: 2000 },
  })
  const { api, requests, waitFor, warms } = server
  try {
    const id = await server.rootSession("Warming UI fixture")
    await api("POST", `/api/session/${id}/prompt`, { text: "integration-parent: delegate to the explore subagent and wait" })
    await waitFor(() => warms(id).length > 0, "root warming before the UI opens")
    await api("POST", `/api/experimental/session/${id}/wait`, {}, 60000)
    const history = JSON.stringify(await api("GET", `/api/session/${id}/message`))
    const ordinaryBefore = requests.filter((request) => !request.warm).length
    const scenario = {
      command: [binary, "--server", server.base, "--session", id, server.worktree], cwd: server.worktree, width: 160, height: 44,
      steps: [
        { wait: "Requests Sent", timeout: 60, name: "sidebar indicator" },
        { wait: "Cache Read", timeout: 10, name: "usage rows" },
        { snapshot: "sidebar" },
        { count: "Requests Sent", name: "sidebar count" },
        { type: "/warming stop" }, { sleep: 0.5 }, { key: "enter" },
        { wait: "Warming stopped", timeout: 15, name: "stop acknowledged" },
        { wait: "By user", timeout: 10, name: "stopped state" },
        { type: "/warming start" }, { sleep: 0.5 }, { key: "enter" },
        { wait: "Warming started", timeout: 15, name: "start acknowledged" },
        { type: "/warming extend 30m" }, { sleep: 0.5 }, { key: "enter" },
        { wait: "Warming window extended", timeout: 15, name: "extend acknowledged" },
        { type: "/warming bogus" }, { sleep: 0.5 }, { key: "enter" },
        { wait: "extend \\[duration\\]", timeout: 10, name: "usage toast" },
        { sleep: 2 },
        { resize: 90 }, { sleep: 2 }, { snapshot: "narrow" },
        { count: "Requests Sent|\\bWarm(?:ing)?\\b", name: "narrow count" },
      ],
    }
    const env = { ...server.env, TERM: "xterm-256color", COLORTERM: "truecolor" }
    const driver = spawn("python3", [join(project, "tests", "tui_driver.py"), JSON.stringify(scenario)], { env, stdio: ["ignore", "pipe", "pipe"], signal: t.signal })
    let output = ""
    let errors = ""
    driver.stdout.on("data", (chunk) => { output += chunk })
    driver.stderr.on("data", (chunk) => { errors = (errors + chunk).slice(-8000) })
    await new Promise<void>((done, reject) => { driver.once("error", reject); driver.once("close", () => done()) })
    const result = JSON.parse(output || "{}")
    const log = await readFile(join(server.home, "state", "opencode", "session-warming", "plugin.log"), "utf8").catch(() => "")
    assert.equal(result.failed, null, `TUI step failed: ${result.failed}\n${result.screen}\n${errors}\n${log.slice(-4000)}`)
    assert.match(log, /\[session-warming\] ui-ready/)
    assert.equal(result.results.find((value: { name: string }) => value.name === "sidebar count").count, 1, "exactly one sidebar indicator")
    assert.ok(result.results.find((value: { name: string }) => value.name === "narrow count").count >= 1, `narrow fallback missing\n${result.snapshots.narrow}`)
    const final = (await server.rpc("status", { sessionID: id })).status
    assert.equal(final.manualStopped, false)
    assert.equal(final.durationMs, 600000 + 1800000, "the TUI extension reached the server")
    assert.equal(requests.filter((request) => !request.warm).length, ordinaryBefore, "TUI controls never submit a model prompt")
    assert.equal(JSON.stringify(await api("GET", `/api/session/${id}/message`)), history, "controls write no conversation history")
  } catch (error) {
    throw new Error(`TUI integration failed: ${String(error)}\n${server.logs.text}`, { cause: error })
  } finally { await server.stop() }
})
