export const SUPPORTED_OPENCODE_VERSION_RANGE = "1.18.x"

export function isSupportedOpenCodeVersion(version: unknown): version is string {
  return typeof version === "string" && /^1\.18\.(?:0|[1-9]\d*)$/.test(version)
}
