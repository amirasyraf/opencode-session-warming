import assert from "node:assert/strict"
import { test } from "node:test"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { KEEPALIVE } from "../protocol.ts"
import { startServer } from "./v2-server.ts"

test("OpenCode V2 warms a blocked root over HTTP, keeps history clean, and honours RPC controls", { timeout: 180000 }, async (t) => {
  const server = await startServer(t.signal)
  const { api, rpc, requests, waitFor, warms } = server
  try {
    const id = await server.rootSession("warming integration")
    await api("POST", `/api/session/${id}/prompt`, { text: "integration-parent: delegate to the explore subagent and wait" })
    await waitFor(() => warms(id).length > 0, "root warming during the foreground subagent")
    const warm = warms(id)[0]
    const ordinary = requests.filter((request) => request.session === id && !request.warm && request.at <= warm.at).at(-1)!
    assert.deepEqual(warm.input.slice(0, -1), ordinary.input, "replay keeps the complete captured input as its prefix")
    assert.equal(warm.encoding, ordinary.encoding, "ChatGPT replays preserve the ordinary body encoding")
    assert.ok(ordinary.encoding === undefined || ordinary.encoding === "zstd", "ordinary requests use plain JSON or zstd")
    assert.ok(requests.some((request) => request.session !== id && !request.warm), "child requests reached the mock")
    assert.ok(requests.filter((request) => request.session !== id).every((request) => !request.warm), "children never warm")
    assert.ok(requests.every((request) => request.auth), "every request used the isolated credential")

    const status = await rpc("status", { sessionID: id }) as { status?: Record<string, unknown> }
    assert.equal(status.status?.model, "gpt-6.1-sol")
    assert.equal(status.status?.adapterID, "codex")
    assert.equal(JSON.stringify(status).includes("integration-only"), false)

    await api("POST", `/api/experimental/session/${id}/wait`, {}, 60000)
    const history = JSON.stringify(await api("GET", `/api/session/${id}/message`))
    assert.equal(history.includes(KEEPALIVE), false, "keepalive never enters session history")
    assert.equal(/"text":"OK"/.test(history), false, "warm responses never enter session history")

    const settled = warms(id).length
    await waitFor(() => warms(id).length > settled, "warming after the final step")
    assert.equal((await rpc("control", { requestID: "runtime-stop", sessionID: id, action: "stop" })).result, "stopped")
    await sleep(100)
    const afterStop = warms(id).length
    await sleep(900)
    assert.equal(warms(id).length, afterStop, "no warming while stopped")
    assert.equal(JSON.stringify(await api("GET", `/api/session/${id}/message`)), history, "stop writes no history")
    assert.equal((await rpc("control", { requestID: "runtime-start", sessionID: id, action: "start" })).result, "started")
    const fresh = (await rpc("status", { sessionID: id })).status as { expiresAt: number; startedAt: number; manualStopped?: boolean }
    assert.equal(fresh.expiresAt - fresh.startedAt, 6000)
    assert.notEqual(fresh.manualStopped, true)
    await waitFor(() => warms(id).length > afterStop, "warming after manual start")
    assert.equal(JSON.stringify(await api("GET", `/api/session/${id}/message`)), history, "start writes no history")
    assert.equal((await rpc("control", { requestID: "runtime-extend", sessionID: id, action: "extend", durationMs: 1000 })).result, "extended")
    const extended = (await rpc("status", { sessionID: id })).status as { expiresAt: number; startedAt: number; durationMs: number }
    assert.equal(extended.durationMs, 7000)
    assert.equal(extended.startedAt, fresh.startedAt, "extension keeps the window")
    assert.equal(extended.expiresAt - extended.startedAt, 7000)
    assert.equal(JSON.stringify(await api("GET", `/api/session/${id}/message`)), history, "extend writes no history")

    const cancelled = await server.rootSession("cancellation")
    await api("POST", `/api/session/${cancelled}/prompt`, { text: "integration-parent: delegate to the explore subagent and wait" })
    await waitFor(() => warms(cancelled).length > 0, "second root warming")
    await api("POST", `/api/session/${cancelled}/interrupt`, {})
    const before = warms(cancelled).length
    await waitFor(() => warms(cancelled).length > before, "cancellation keeps the captured snapshot warm", 5000)

    const state = join(server.home, "state", "opencode", "session-warming")
    const log = await readFile(join(state, "plugin.log"), "utf8")
    assert.match(log, /\[session-warming\] ready/)
    assert.match(log, /\[session-warming\] warm-completed/)
    const readJournal = async () => {
      const segments = await readdir(join(state, "events"))
      assert.ok(segments.length > 0, "journal segments written")
      return (await Promise.all(segments.map((name) => readFile(join(state, "events", name), "utf8")))).join("")
    }
    // The journal flushes asynchronously (one-second buffer), so wait for the control records to land.
    await waitFor(async () => /"event":"warming.user-extended"/.test(await readJournal()), "journal records the extension", 10000)
    const journal = await readJournal()
    for (const secret of ["integration-only", "never-use-this", "integration-parent", KEEPALIVE]) {
      assert.equal(log.includes(secret), false, `plugin log leaks ${secret}`)
      assert.equal(journal.includes(secret), false, `journal leaks ${secret}`)
    }
    assert.match(journal, /"event":"ordinary.step-usage"/)
    const extendedRecord = journal.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((record) => record.event === "warming.user-extended")
    assert.equal(extendedRecord.reason, "user-extend")
    assert.equal(extendedRecord.durationMs, 1000)
  } catch (error) {
    throw new Error(`Runtime integration failed: ${String(error)}\n${server.logs.text}`, { cause: error })
  } finally { await server.stop() }
})
