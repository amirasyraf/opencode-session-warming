export const SUPPORTED_OPENCODE_VERSION_RANGE = "2.1.x"

/** OpenCode V2 stable 2.1 releases only. V1 1.18.x is no longer supported by this branch. */
export function isSupportedOpenCodeVersion(version: unknown): version is string {
  return typeof version === "string" && /^2\.1\.(?:0|[1-9]\d*)$/.test(version)
}
