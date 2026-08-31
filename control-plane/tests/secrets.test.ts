import 'dotenv/config'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'

import { loadConfig } from '../src/config.js'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { orgs, fleets, services, secrets } from '../src/db/schema.js'
import { parseManifest } from '../src/manifest/parse.js'
import { syncManifest } from '../src/manifest/sync.js'
import {
  setSecret,
  listSecrets,
  deleteSecret,
  resolveSecrets,
  buildEnv,
  assertValidKey,
} from '../src/secrets/store.js'
import { ApiError } from '../src/api/errors.js'

describe('the fleet secret store', () => {
  let ctx: AppContext
  let orgId: string
  let fleetId: string
  let webId: string
  let dbId: string

  before(async () => {
    ctx = createContext(loadConfig())
    const [org] = await ctx.db.insert(orgs).values({ name: 'secrets-test' }).returning()
    orgId = org!.id
    const [fleet] = await ctx.db
      .insert(fleets)
      .values({ orgId, name: `secrets-${Date.now()}` })
      .returning()
    fleetId = fleet!.id

    const [web] = await ctx.db
      .insert(services)
      .values({ fleetId, name: 'web', image: 'nginx' })
      .returning()
    webId = web!.id
    const [db] = await ctx.db
      .insert(services)
      .values({ fleetId, name: 'postgres', image: 'postgres:16' })
      .returning()
    dbId = db!.id
  })

  after(async () => {
    await ctx.db.delete(orgs).where(eq(orgs.id, orgId))
    await closeContext(ctx)
  })

  test('a stored value comes back out intact', async () => {
    await setSecret(ctx, { fleetId }, 'DATABASE_URL', 'postgres://app:pw@postgres:5432/app')
    const { values, missing } = await resolveSecrets(ctx, fleetId, webId, ['DATABASE_URL'])
    assert.equal(values.DATABASE_URL, 'postgres://app:pw@postgres:5432/app')
    assert.deepEqual(missing, [])
  })

  test('the value is encrypted at rest, not merely hidden', async () => {
    const [row] = await ctx.db
      .select({ encrypted: secrets.encryptedValue })
      .from(secrets)
      .where(eq(secrets.key, 'DATABASE_URL'))
      .limit(1)

    // The whole envelope, serialised, must not contain the plaintext anywhere.
    const serialised = JSON.stringify(row!.encrypted)
    assert.ok(!serialised.includes('postgres://'), 'plaintext found in the stored envelope')
    assert.ok(!serialised.includes('pw@'), 'plaintext found in the stored envelope')
    assert.ok(row!.encrypted.wrappedDek, 'expected an envelope-encrypted DEK')
  })

  test('setting the same key again replaces rather than duplicating', async () => {
    await setSecret(ctx, { fleetId }, 'DATABASE_URL', 'postgres://second')
    const rows = await ctx.db
      .select({ id: secrets.id })
      .from(secrets)
      .where(eq(secrets.fleetId, fleetId))
    assert.equal(rows.filter(() => true).length, 1, 'expected exactly one row for one key')

    const { values } = await resolveSecrets(ctx, fleetId, webId, ['DATABASE_URL'])
    assert.equal(values.DATABASE_URL, 'postgres://second')
  })

  test('one fleet-wide value serves every service in the fleet', async () => {
    // This is the reason the store is fleet-scoped: postgres sets the password
    // and web connects with it, and neither should have its own copy.
    const forWeb = await resolveSecrets(ctx, fleetId, webId, ['DATABASE_URL'])
    const forDb = await resolveSecrets(ctx, fleetId, dbId, ['DATABASE_URL'])
    assert.equal(forWeb.values.DATABASE_URL, forDb.values.DATABASE_URL)
  })

  test('a service override wins over the fleet value, for that service only', async () => {
    await setSecret(ctx, { fleetId, serviceId: webId }, 'DATABASE_URL', 'postgres://web-only')

    const forWeb = await resolveSecrets(ctx, fleetId, webId, ['DATABASE_URL'])
    const forDb = await resolveSecrets(ctx, fleetId, dbId, ['DATABASE_URL'])

    assert.equal(forWeb.values.DATABASE_URL, 'postgres://web-only')
    assert.equal(forDb.values.DATABASE_URL, 'postgres://second', 'the override leaked to another service')
  })

  test('an unset name is reported as missing rather than resolving to undefined', async () => {
    const { values, missing } = await resolveSecrets(ctx, fleetId, webId, ['NOT_SET_ANYWHERE'])
    assert.deepEqual(missing, ['NOT_SET_ANYWHERE'])
    assert.ok(!('NOT_SET_ANYWHERE' in values))
  })

  test('listing returns names and timestamps and no values at all', async () => {
    const rows = await listSecrets(ctx, fleetId)
    const serialised = JSON.stringify(rows)
    assert.ok(rows.length >= 2)
    assert.ok(!serialised.includes('postgres://'), 'a value reached the listing')
    for (const row of rows) {
      assert.ok(!('value' in row), 'listing exposed a value field')
      assert.ok(!('encryptedValue' in row), 'listing exposed the ciphertext')
    }
  })

  test('deleting an override falls back to the fleet value', async () => {
    assert.equal(await deleteSecret(ctx, { fleetId, serviceId: webId }, 'DATABASE_URL'), true)
    const forWeb = await resolveSecrets(ctx, fleetId, webId, ['DATABASE_URL'])
    assert.equal(forWeb.values.DATABASE_URL, 'postgres://second')
  })

  test('deleting something that is not there says so instead of pretending', async () => {
    assert.equal(await deleteSecret(ctx, { fleetId }, 'NEVER_EXISTED'), false)
  })

  test('keys that are not usable environment variable names are refused', () => {
    assert.throws(() => assertValidKey('my-key'), ApiError)
    assert.throws(() => assertValidKey('1STARTS_WITH_DIGIT'), ApiError)
    assert.throws(() => assertValidKey(''), ApiError)
    assert.doesNotThrow(() => assertValidKey('DATABASE_URL'))
    assert.doesNotThrow(() => assertValidKey('_PRIVATE'))
  })

  describe('the environment handed to a container', () => {
    test('merges plain manifest values with resolved secrets', async () => {
      const { env, missing } = await buildEnv(ctx, fleetId, {
        id: webId,
        env: { LOG_LEVEL: 'debug', NODE_NAME: 'sayyestoheaven' },
        secretRefs: ['DATABASE_URL'],
      })
      assert.deepEqual(missing, [])
      assert.equal(env.LOG_LEVEL, 'debug')
      assert.equal(env.NODE_NAME, 'sayyestoheaven')
      assert.equal(env.DATABASE_URL, 'postgres://second')
    })

    test('a secret wins over a plain value of the same name', async () => {
      // Otherwise a manifest could silently shadow a credential with a
      // placeholder committed to git.
      const { env } = await buildEnv(ctx, fleetId, {
        id: webId,
        env: { DATABASE_URL: 'postgres://placeholder-from-git' },
        secretRefs: ['DATABASE_URL'],
      })
      assert.equal(env.DATABASE_URL, 'postgres://second')
    })

    test('reports what is missing without dropping what resolved', async () => {
      const { env, missing } = await buildEnv(ctx, fleetId, {
        id: webId,
        env: { LOG_LEVEL: 'info' },
        secretRefs: ['DATABASE_URL', 'STRIPE_KEY'],
      })
      assert.deepEqual(missing, ['STRIPE_KEY'])
      assert.equal(env.DATABASE_URL, 'postgres://second')
      assert.equal(env.LOG_LEVEL, 'info')
    })
  })

  describe('the manifest carries env and secret names through', () => {
    test('env and secrets survive an apply instead of being dropped', async () => {
      await syncManifest(
        ctx,
        fleetId,
        orgId,
        parseManifest(`
fleet: homelab
services:
  web:
    image: nginx
    env:
      LOG_LEVEL: debug
      PORT: 8080
    secrets: [DATABASE_URL]
`)
      )

      const [row] = await ctx.db
        .select({ env: services.env, secretRefs: services.secretRefs })
        .from(services)
        .where(eq(services.id, webId))
        .limit(1)

      assert.deepEqual(row!.secretRefs, ['DATABASE_URL'])
      assert.equal(row!.env.LOG_LEVEL, 'debug')
      // YAML gives a number here; an environment variable is always a string.
      assert.equal(row!.env.PORT, '8080')
      assert.equal(typeof row!.env.PORT, 'string')
    })
  })
})

describe('manifest validation of env and secrets', () => {
  const parse = (body: string) =>
    parseManifest(`fleet: homelab\nservices:\n  web:\n    image: nginx\n${body}`)

  test('an env key that is not a legal variable name is rejected with the rule', () => {
    assert.throws(
      () => parse('    env:\n      "my-key": value\n'),
      (err: Error) => /not a usable environment variable name/.test(err.message)
    )
  })

  test('a secret name that is not a legal variable name is rejected', () => {
    assert.throws(
      () => parse('    secrets: ["not-a-var"]\n'),
      (err: Error) => /not a usable environment variable name/.test(err.message)
    )
  })

  test('naming the same key in both env and secrets is an ambiguity, not a merge', () => {
    // The secret wins at runtime. Rather than let the file imply otherwise,
    // say so at validation time.
    assert.throws(
      () => parse('    env:\n      DATABASE_URL: placeholder\n    secrets: [DATABASE_URL]\n'),
      (err: Error) => /appears in both/.test(err.message)
    )
  })

  test('a manifest with neither is still perfectly valid', () => {
    const parsed = parse('    placement: flexible\n')
    assert.deepEqual(parsed.services[0]!.env, {})
    assert.deepEqual(parsed.services[0]!.secrets, [])
  })
})
