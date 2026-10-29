import assert from "node:assert/strict"
import { test } from "node:test"
import { attach, detach, disposeResidents, fingerprint, RESIDENT_VERSION } from "../resident.ts"
import type { Resident } from "../resident.ts"

test("reload replaces a version-1 resident instead of retaining the old request validator", async () => {
  const options = { enabled: true }
  let disposed = 0
  const create = (print: string): Resident => ({ fingerprint: print, scopes: 0, idle: () => false,
    watchIdle: () => {}, dispose: async () => { disposed++ } })
  try {
    assert.ok(RESIDENT_VERSION > 1)
    const old = attach("validator-reload", JSON.stringify([1, options]), () => create(JSON.stringify([1, options])))
    assert.equal(await detach("validator-reload", old.resident), "parked")
    const current = attach("validator-reload", fingerprint(options), () => create(fingerprint(options)))
    assert.equal(current.adopted, false)
    assert.notEqual(current.resident, old.resident)
    assert.equal(disposed, 1, "old resident is disposed before the new scope uses its engine")
    assert.equal(attach("validator-reload", fingerprint(options), () => { throw new Error("must adopt") }).adopted, true)
  } finally { await disposeResidents() }
})
