export const SUPPORTED_OPENCODE_VERSION_RANGE = "2.1.x, 2.2.x, or 2.3.x"

/** Stable 2.1, 2.2, and 2.3 releases; future minors and prereleases need compatibility verification. */
export function isSupportedOpenCodeVersion(version: unknown): version is string {
  return typeof version === "string" && version.trim() === version && /^2\.[123]\.(?:0|[1-9]\d*)$/.test(version)
}
