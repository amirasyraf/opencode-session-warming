import assert from "node:assert/strict"
import { test } from "node:test"
import { isSupportedOpenCodeVersion } from "../compatibility.ts"

test("verified stable OpenCode versions are admitted", () => {
  for (const version of ["2.1.0", "2.1.2", "2.1.123", "2.2.0", "2.2.1", "2.2.123"]) {
    assert.equal(isSupportedOpenCodeVersion(version), true, version)
  }
})

test("unverified versions, prereleases, and malformed versions stay disabled", () => {
  for (const version of [undefined, null, 2.2, "", "1.18.30", "2.0.32", "2.3.0", "3.0.0",
    "2.2.0-beta.1", "2.1.0-dev", "2.2.0+build", "v2.2.0", "2.1.01", "2.2.00", "2.2.0\n"]) {
    assert.equal(isSupportedOpenCodeVersion(version), false, String(version))
  }
})
