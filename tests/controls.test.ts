import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate, setTimeout as sleep } from "node:timers/promises"
import { ControlClient, ControlServer, CONTROL_TIMEOUT_MS, parseDuration, parseWarmingCommand } from "../controls.ts"
import type { ControlRequest } from "../controls.ts"

const prefix = "session-warming.control.v1:"
const ack = "session-warming.ack.v1:"
const request = (requestID = "request", action: "start" | "stop" = "start"): ControlRequest =>
  ({ requestID, action, sessionID: "root", deadlineAt: Date.now() + CONTROL_TIMEOUT_MS })

test("warming parser reserves one exact command and consumes invalid arguments locally", () => {
  assert.equal(parseWarmingCommand(" /warming stop "), "stop")
  assert.equal(parseWarmingCommand("/warming\tstart"), "start")
  assert.equal(parseWarmingCommand("/warming"), "menu")
  assert.deepEqual(parseWarmingCommand("/warming extend"), { action: "extend" })
  assert.deepEqual(parseWarmingCommand("/warming extend 1h30m"), { action: "extend", durationMs: 5_400_000 })
  assert.equal(parseDuration("1h30m"), 5_400_000)
  for (const input of ["/warming restart", "/warming start extra", "/warming extend nope", "/warming extend 1h 30m",
    "/warming extend 1m1h", "/warming\nstop", "/warming stop\nsecret"])
    assert.equal(parseWarmingCommand(input), "invalid", input)
  for (const input of ["/warming-other stop", "Explain /warming start", "ordinary prompt", "!/warming stop"])
    assert.equal(parseWarmingCommand(input), undefined, input)
})

test("client requires a matching acknowledgement and never sends editor contents", async () => {
  let sent = ""
  const client = new ControlClient(async (command) => { sent = command })
  const result = client.request("stop", "root")
  await setImmediate()
  const body = JSON.parse(sent.slice(prefix.length))
  assert.deepEqual(Object.keys(body).sort(), ["action", "deadlineAt", "requestID", "sessionID"])
  let settled = false
  void result.then(() => { settled = true })
  client.receive(ack + JSON.stringify({ ...body, sessionID: "other", result: "stopped" }))
  client.receive(ack + JSON.stringify({ ...body, action: "start", result: "stopped" }))
  client.receive(ack + JSON.stringify({ ...body, result: "stopped", prompt: "secret" }))
  await setImmediate()
  assert.equal(settled, false)
  client.receive(ack + JSON.stringify({ ...body, result: "stopped" }))
  assert.equal(await result, "stopped")
  client.dispose()
})

test("control round trip deduplicates both concurrent and completed requests", async () => {
  let calls = 0
  let release!: () => void
  const replies: string[] = []
  const server = new ControlServer(async () => {
    calls++
    await new Promise<void>((resolve) => { release = resolve })
    return "started"
  }, async (command) => { replies.push(command) })
  const body = { ...request(), action: "extend" as const, durationMs: 30_000 }
  const command = prefix + JSON.stringify(body)
  const first = server.receive(command)
  const duplicate = server.receive(command)
  await setImmediate()
  assert.equal(calls, 1)
  release()
  await Promise.all([first, duplicate])
  await server.receive(command)
  await server.receive(prefix + JSON.stringify({ ...body, action: "stop" }))
  assert.equal(calls, 1)
  assert.equal(replies.length, 2)
  assert.ok(replies.every((reply) => JSON.parse(reply.slice(ack.length)).result === "started"))
  server.dispose()
})

test("server validates envelopes and rejects expired, oversized and future requests", async () => {
  let calls = 0
  const server = new ControlServer(async () => { calls++; return "started" }, async () => {})
  const body = request()
  for (const value of [{ ...body, action: "reset" }, { ...body, sessionID: "../secret" }, { ...body, headers: "secret" },
    { ...body, action: "start", durationMs: 30_000 }, { ...body, action: "extend", durationMs: 0 },
    { ...body, deadlineAt: Date.now() - 1 }, { ...body, deadlineAt: Date.now() + CONTROL_TIMEOUT_MS + 10000 }])
    await server.receive(prefix + JSON.stringify(value))
  await server.receive(prefix + "null")
  await server.receive(prefix + "{" + " ".repeat(1024))
  await server.receive("other-plugin:" + JSON.stringify(body))
  assert.equal(calls, 0)
  server.dispose()
})

test("actions are ordered per session while independent roots proceed", async () => {
  const applied: string[] = []
  let release!: () => void
  const server = new ControlServer(async (body) => {
    applied.push(body.requestID)
    if (body.requestID === "first") await new Promise<void>((done) => { release = done })
    return "stopped"
  }, async () => {})
  const first = server.receive(prefix + JSON.stringify(request("first", "stop")))
  const second = server.receive(prefix + JSON.stringify(request("second")))
  await server.receive(prefix + JSON.stringify({ ...request("independent"), sessionID: "other" }))
  assert.deepEqual(applied, ["first", "independent"])
  release()
  await Promise.all([first, second])
  assert.deepEqual(applied, ["first", "independent", "second"])
  server.dispose()
})

test("deletion and disposal fence metadata continuations, and delivery failures are contained", async () => {
  for (const operation of ["cancel", "dispose"] as const) {
    let release!: () => void
    let applied = false
    const server = new ControlServer(async (_body, current) => {
      await new Promise<void>((done) => { release = done })
      if (current()) applied = true
      return "started"
    }, async () => { throw new Error("fixture transport failure") })
    const work = server.receive(prefix + JSON.stringify(request()))
    await setImmediate()
    if (operation === "cancel") server.cancel("root")
    else server.dispose()
    release()
    await work
    assert.equal(applied, false, operation)
    server.dispose()
  }
  const client = new ControlClient(async () => { throw new Error("fixture transport failure") })
  assert.equal(await client.request("stop", "root"), "unconfirmed")
  const pending = new ControlClient(async () => {})
  const work = pending.request("stop", "root")
  pending.dispose()
  assert.equal(await work, "unconfirmed")
  assert.equal(await pending.request("start", "root"), "unavailable")
})

test("expired metadata lookups cannot apply controls after local deadlines", async () => {
  let release!: () => void
  let applied = false
  const server = new ControlServer(async (_body, current) => {
    await new Promise<void>((done) => { release = done })
    if (current()) applied = true
    return "started"
  }, async () => {})
  const work = server.receive(prefix + JSON.stringify({ ...request(), deadlineAt: Date.now() + 25 }))
  await sleep(50)
  await work
  release()
  await setImmediate()
  assert.equal(applied, false)
  server.dispose()
})

test("client reports an unconfirmed result when the server does not acknowledge", { timeout: 7000 }, async () => {
  const client = new ControlClient(async () => {})
  const [result] = await Promise.all([client.request("stop", "root"), sleep(CONTROL_TIMEOUT_MS + 50)])
  assert.equal(result, "unconfirmed")
  client.dispose()
})

test("client and server pressure limits reject excess work without evicting active controls", async () => {
  const client = new ControlClient(async () => {})
  const pending = Array.from({ length: 8 }, () => client.request("stop", "root"))
  assert.equal(await client.request("stop", "root"), "busy")
  client.dispose()
  assert.ok((await Promise.all(pending)).every((result) => result === "unconfirmed"))
  const releases: (() => void)[] = []
  const replies: string[] = []
  const server = new ControlServer(async () => {
    await new Promise<void>((done) => { releases.push(done) })
    return "started"
  }, async (command) => { replies.push(command) })
  const work = Array.from({ length: 32 }, (_, index) => server.receive(prefix + JSON.stringify({ ...request(`request-${index}`), sessionID: `root-${index}` })))
  await setImmediate()
  await server.receive(prefix + JSON.stringify(request("excess")))
  assert.equal(JSON.parse(replies[0].slice(ack.length)).result, "busy")
  for (const release of releases) release()
  await Promise.all(work)
  server.dispose()
})
