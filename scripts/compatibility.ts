import { execFileSync, spawnSync } from "node:child_process"
import { appendFile, chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isSupportedOpenCodeVersion, SUPPORTED_OPENCODE_VERSION_RANGE } from "../compatibility.ts"

export const BASELINE = "2.1.0"
const project = fileURLToPath(new URL("..", import.meta.url))
const compare = (a: string, b: string) => {
  const left = a.split(".").map(Number)
  const right = b.split(".").map(Number)
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
}

export function probeVersion(version: unknown): version is string {
  return typeof version === "string" && version.trim() === version && /^2\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version) &&
    version.split(".").every((part) => Number.isSafeInteger(Number(part))) && compare(version, BASELINE) >= 0
}

export function compatibilityMatrix(published: unknown, requested?: string) {
  if (!Array.isArray(published) || !published.every((version) => typeof version === "string")) throw new Error("Invalid registry version list")
  const versions = [...new Set(published.filter(probeVersion))].sort(compare)
  if (!versions.includes(BASELINE)) throw new Error(`Registry is missing baseline ${BASELINE}`)
  if (requested) {
    if (!probeVersion(requested) || !versions.includes(requested)) throw new Error("Requested version must be a published stable V2 release at or above the baseline")
    return { include: [{ version: requested, candidate: !isSupportedOpenCodeVersion(requested) }] }
  }
  const selected = new Set([BASELINE])
  const minors = new Map<string, string>()
  for (const version of versions) if (isSupportedOpenCodeVersion(version)) minors.set(version.split(".").slice(0, 2).join("."), version)
  for (const version of minors.values()) selected.add(version)
  selected.add(versions.at(-1)!)
  return { include: [...selected].sort(compare).map((version) => ({ version, candidate: !isSupportedOpenCodeVersion(version) })) }
}

/** New minors are tested only in a disposable source copy; the installed plugin's guard never changes. */
export async function stageProbe(source: string, destination: string, version: string) {
  if (!probeVersion(version)) throw new Error("Only stable V2 releases at or above the baseline can be probed")
  await mkdir(destination)
  for (const name of await readdir(source)) {
    if (/\.(?:ts|tsx)$/.test(name) || name === "package.json") await cp(join(source, name), join(destination, name))
  }
  await cp(join(source, "tests"), join(destination, "tests"), { recursive: true })
  await symlink(join(source, "node_modules"), join(destination, "node_modules"), "dir")
  await writeFile(join(destination, "compatibility-base.ts"), await readFile(join(source, "compatibility.ts"), "utf8"))
  await writeFile(join(destination, "compatibility.ts"), `
import { isSupportedOpenCodeVersion as supported } from "./compatibility-base.ts"
export const SUPPORTED_OPENCODE_VERSION_RANGE = ${JSON.stringify(`${SUPPORTED_OPENCODE_VERSION_RANGE}; isolated probe ${version}`)}
export function isSupportedOpenCodeVersion(version: unknown): version is string {
  return version === ${JSON.stringify(version)} || supported(version)
}
`)
}

async function installBinary(version: string, directory: string) {
  if (!["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch)) throw new Error("Compatibility runner requires macOS or Linux on arm64/x64")
  const packed = JSON.parse(execFileSync("npm", ["pack", `@opencode/cli-${process.platform}-${process.arch}@${version}`,
    "--ignore-scripts", "--json", "--pack-destination", directory], { cwd: directory, encoding: "utf8", timeout: 120000 })) as { filename: string }[]
  const filename = packed[0]?.filename
  if (!filename || basename(filename) !== filename) throw new Error("Invalid package archive name")
  execFileSync("tar", ["-xzf", join(directory, filename), "-C", directory], { timeout: 30000 })
  const binary = join(directory, "package", "bin", "opencode")
  await chmod(binary, 0o755)
  return binary
}

export async function runCompatibility(version: string) {
  if (!probeVersion(version)) throw new Error("Specify an exact stable V2 version at or above the baseline")
  const directory = await mkdtemp(join(tmpdir(), "warming-compatibility-"))
  try {
    const binary = process.env.OPENCODE_BIN ? resolve(process.env.OPENCODE_BIN) : await installBinary(version, directory)
    const actual = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 10000 }).trim().replace(/^opencode v/, "")
    if (actual !== version) throw new Error(`Expected OpenCode ${version}, received ${actual}`)
    const candidate = !isSupportedOpenCodeVersion(version)
    const cwd = candidate ? join(directory, "probe") : project
    if (candidate) await stageProbe(project, cwd, version)
    console.log(`OpenCode ${version}: ${candidate ? "isolated candidate probe; NOT enabled in the installed plugin" : "supported release"}`)
    const result = spawnSync(process.execPath, ["--test", "tests/runtime.integration.ts", "tests/tui.integration.ts"], {
      cwd, env: { ...process.env, OPENCODE_BIN: binary }, stdio: "inherit", timeout: 300000,
    })
    if (result.error || result.status !== 0) throw new Error(`OpenCode ${version} contract tests failed`, { cause: result.error })
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `### OpenCode ${version}: passed\n\nRuntime and TUI contracts passed (${candidate ? "candidate only; support range unchanged" : "supported"}).\n`)
  } finally { await rm(directory, { recursive: true, force: true }) }
}

if (import.meta.main) {
  const [command, version, ...extra] = process.argv.slice(2)
  if (extra.length || !["matrix", "run"].includes(command ?? "")) throw new Error("Usage: compatibility.ts matrix [version] | run <version>")
  if (command === "run") await runCompatibility(version ?? "")
  else {
    const published: unknown = JSON.parse(execFileSync("npm", ["view", "@opencode/cli", "versions", "--json"], {
      encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024,
    }))
    console.log(JSON.stringify(compatibilityMatrix(published, version)))
  }
}
