/**
 * The CLI's copy of the engine wire format, checked against the original.
 *
 * `fleet import` rewrites a compose file's connection strings to the URL Fleet
 * will actually inject, which means it has to know each engine's scheme, port,
 * default user and whether it uses a password. That knowledge lives here, in
 * the control plane, and the CLI cannot import it: they are separate packages,
 * and the CLI is expected to work against a control plane it did not ship
 * with.
 *
 * So it is copied — and a copy nobody checks is a copy that goes wrong
 * silently. The failure would be invisible in the worst way: a manifest that
 * validates, deploys, and leaves an app dialling the wrong port, with the
 * mistake sitting in a generated file the user has no reason to doubt.
 *
 * This test is what makes the duplication acceptable. Change ENGINES and this
 * fails until cli/src/dburl.ts is changed to match.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ENGINES, passwordRefFor } from '../src/manifest/databases.js'

/** The CLI's table, read as source so this test needs no build of the CLI. */
function cliWire(): Record<string, Record<string, unknown>> {
  const src = readFileSync(new URL('../../cli/src/dburl.ts', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('ENGINE_WIRE: Record<string, EngineWire> = {'))
  const table = body.slice(body.indexOf('{'), body.indexOf('\n}') + 2)

  const out: Record<string, Record<string, unknown>> = {}
  for (const line of table.split('\n')) {
    const m = line.match(/^\s*([a-z]+):\s*\{(.+)\},?\s*$/)
    if (!m) continue
    const fields: Record<string, unknown> = {}
    for (const pair of m[2]!.split(',')) {
      const kv = pair.split(':')
      if (kv.length < 2) continue
      const key = kv[0]!.trim()
      const raw = kv.slice(1).join(':').trim().replace(/^'|'$/g, '')
      fields[key] = raw === 'true' ? true : raw === 'false' ? false : /^\d+$/.test(raw) ? Number(raw) : raw
    }
    out[m[1]!] = fields
  }
  return out
}

describe('the CLI knows what the control plane will inject', () => {
  const cli = cliWire()

  test('it lists exactly the engines this control plane manages', () => {
    assert.deepEqual(
      Object.keys(cli).sort(),
      Object.keys(ENGINES).sort(),
      'an engine added here has to be added to cli/src/dburl.ts, or import will leave its connection string alone'
    )
  })

  for (const [name, spec] of Object.entries(ENGINES)) {
    test(`${name}: scheme, port, user and auth match`, () => {
      const mirror = cli[name]
      assert.ok(mirror, `cli/src/dburl.ts has no entry for ${name}`)
      assert.equal(mirror!.scheme, spec.scheme, 'scheme')
      assert.equal(mirror!.port, spec.port, 'port')
      assert.equal(mirror!.usesPassword, spec.usesPassword, 'usesPassword')
      assert.equal(mirror!.usesDatabase, spec.usesDatabase, 'usesDatabase')
      // defaultUser is only read when a password is used; redis has none.
      if (spec.usesPassword) assert.equal(mirror!.defaultUser, spec.defaultUser, 'defaultUser')
    })
  }

  test('the password secret is named the same way on both sides', () => {
    const src = readFileSync(new URL('../../cli/src/dburl.ts', import.meta.url), 'utf8')
    // Same transformation, asserted on a name that exercises the punctuation
    // rule rather than a simple one that would pass under either.
    assert.match(src, /toUpperCase\(\)\.replace\(\/\[\^A-Z0-9\]\+\/g, '_'\)/)
    assert.equal(passwordRefFor('my-db'), 'MY_DB_PASSWORD')
  })
})
