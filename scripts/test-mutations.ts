/** Small, explicit regression-sensitivity checks. Only disposable source copies are modified. */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const source = fileURLToPath(new URL("..", import.meta.url))
const directory = await mkdtemp(join(tmpdir(), "warming-regression-probes-"))
const tests = ["tests/provider-contracts.test.ts", "tests/resident.test.ts"]
const probes = [
  { name: "Haiku eligibility removed", file: "cache-policy.ts", before: "(sonnet|opus|haiku)", after: "(sonnet|opus)",
    test: tests[0], pattern: "serializer accepts Copilot haiku" },
  { name: "native system updates rejected", file: "protocol.ts", before: 'if (object(message) && message.role === "system") {',
    after: 'if (object(message) && message.role === "system") return { reason: "unsupported-input-message" }\n        if (object(message) && message.role === "system") {',
    test: tests[0], pattern: "serializer accepts Copilot .*: updates" },
  { name: "Claude replay loses earlier input", file: "adapters.ts", before: "{ ...snapshot.body, max_tokens: Math.min",
    after: "{ ...snapshot.body, messages: (snapshot.body.messages as unknown[]).slice(-1), max_tokens: Math.min",
    test: tests[0], pattern: "serializer accepts Copilot .*: combined" },
  { name: "reload retains the version-1 validator", file: "resident.ts", before: /export const RESIDENT_VERSION = \d+/,
    after: "export const RESIDENT_VERSION = 1", test: tests[1], pattern: "reload replaces" },
] as const

function run(files: readonly string[], pattern?: string) {
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...(pattern ? [`--test-name-pattern=${pattern}`] : []), ...files],
    { cwd: directory, encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.signal) throw new Error(`Contract subprocess terminated by ${result.signal}`)
  return { status: result.status, output: result.stdout + result.stderr }
}

try {
  await cp(join(source, "package.json"), join(directory, "package.json"))
  for (const file of await readdir(source)) if (file.endsWith(".ts")) await cp(join(source, file), join(directory, file))
  await mkdir(join(directory, "tests"))
  for (const file of [...tests, "tests/provider-fixtures.ts", "tests/helpers.ts"]) await cp(join(source, file), join(directory, file))
  await symlink(join(source, "node_modules"), join(directory, "node_modules"), "dir")
  const baseline = run(tests)
  assert.equal(baseline.status, 0, `Unmodified contracts must pass before any regression probe:\n${baseline.output}`)
  for (const probe of probes) {
    const path = join(directory, probe.file)
    const original = await readFile(path, "utf8")
    const mutated = original.replace(probe.before, probe.after)
    assert.notEqual(mutated, original, `Probe must still match its source: ${probe.name}`)
    try {
      await writeFile(path, mutated)
      const result = run([probe.test], probe.pattern)
      assert.equal(result.status, 1, `Tests did not detect: ${probe.name}\n${result.output}`)
      assert.match(result.output, /ERR_ASSERTION/, `Must fail an assertion, not an import or runtime setup error: ${probe.name}\n${result.output}`)
      console.log(`Detected regression: ${probe.name}`)
    } finally { await writeFile(path, original) }
  }
  console.log(`All ${probes.length} regression probes detected; installed plugin source was not modified.`)
} finally { await rm(directory, { recursive: true, force: true }) }
