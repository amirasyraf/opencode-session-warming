import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, readFile, rm, writeFile, mkdir, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { compatibilityMatrix, probeVersion, stageProbe } from "../scripts/compatibility.ts"

test("release discovery selects baseline, latest patch of each supported minor, and latest V2 candidate", () => {
  const matrix = compatibilityMatrix(["2.3.1", "2.2.0", "2.1.9", "2.1.0", "2.1.10", "2.2.5", "2.3.0", "2.3.1",
    "2.4.0-beta.1", "3.0.0", "1.19.4", "0.0.0-dev-1"])
  assert.deepEqual(matrix.include, [
    { version: "2.1.0", candidate: false }, { version: "2.1.10", candidate: false },
    { version: "2.2.5", candidate: false }, { version: "2.3.1", candidate: true },
  ])
  assert.deepEqual(compatibilityMatrix(["2.1.0", "2.2.0"]).include.map((entry) => entry.version), ["2.1.0", "2.2.0"])
})

test("release discovery fails closed on bad registry data and invalid explicit versions", () => {
  for (const value of [null, {}, [1], ["1.19.4"], ["2.2.0"]]) assert.throws(() => compatibilityMatrix(value))
  const published = ["2.1.0", "2.2.0", "2.3.0"]
  assert.deepEqual(compatibilityMatrix(published, "2.3.0").include, [{ version: "2.3.0", candidate: true }])
  for (const version of ["2.0.0", "2.3.1", "latest", "2.3.0-beta.1", "2.3.0\n", "2.03.0", "3.0.0", "2.3.0;echo injected"]) {
    assert.throws(() => compatibilityMatrix(published, version))
  }
  assert.equal(probeVersion("2.9007199254740992.0"), false)
})

test("candidate staging enables exactly one candidate only in a disposable copy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "warming-probe-unit-"))
  const source = join(directory, "source")
  const destination = join(directory, "probe")
  const guard = `export const SUPPORTED_OPENCODE_VERSION_RANGE = "2.1.x or 2.2.x"
export const isSupportedOpenCodeVersion = (version: unknown): version is string => version === "2.2.0"
`
  try {
    await mkdir(join(source, "tests"), { recursive: true })
    await mkdir(join(source, "node_modules"))
    await writeFile(join(source, "package.json"), '{"type":"module"}')
    await writeFile(join(source, "compatibility.ts"), guard)
    await writeFile(join(source, "tests", "fixture.ts"), "export {}")
    await writeFile(join(source, "opencode.json"), "private configuration")
    await stageProbe(source, destination, "2.3.0")
    const staged = await import(pathToFileURL(join(destination, "compatibility.ts")).href)
    assert.equal(staged.isSupportedOpenCodeVersion("2.3.0"), true)
    assert.equal(staged.isSupportedOpenCodeVersion("2.2.0"), true)
    assert.equal(staged.isSupportedOpenCodeVersion("2.3.1"), false)
    assert.equal(staged.isSupportedOpenCodeVersion("3.0.0"), false)
    assert.equal(await readFile(join(source, "compatibility.ts"), "utf8"), guard)
    assert.equal(await realpath(join(destination, "node_modules")), await realpath(join(source, "node_modules")))
    await assert.rejects(readFile(join(destination, "opencode.json")))
    await assert.rejects(stageProbe(source, join(directory, "invalid"), "3.0.0"))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
