export const SUPPORTED_OPENCODE_VERSION_RANGE = "2.1.x or 2.2.x"

/** Stable 2.1 and 2.2 releases; future minors and prereleases need compatibility verification. */
export function isSupportedOpenCodeVersion(version: unknown): version is string {
  return typeof version === "string" && version.trim() === version && /^2\.[12]\.(?:0|[1-9]\d*)$/.test(version)
}
