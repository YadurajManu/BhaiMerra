/**
 * Managed databases.
 *
 * The manifest that prompted this declared Postgres by hand and got four
 * things wrong across a day: PGDATA pointed at the mount root, the health
 * check waited on an engine that does not speak HTTP, the volume outlived a
 * password change so the engine kept the old one, and POSTGRES_PASSWORD and
 * DB_PASSWORD were two secrets a person had to type identically.
 *
 * Every test here pins one of those.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseManifest, ManifestError } from '../src/manifest/parse.js'
import {
  ENGINES,
  connectionUrl,
  clientEnv,
  expandDatabase,
  passwordRefFor,
  prefixFor,
  splitEngine,
  volumeNameFor,
} from '../src/manifest/databases.js'
import { interpolate, referencedSecrets } from '../src/secrets/store.js'

const manifest = (body: string) => parseManifest(body, 'acme')

describe('declaring a database', () => {
  const source = `
fleet: homelab
databases:
  main:
    engine: postgres@16
    node: kakashi
services:
  api:
    build: ./api
    uses: [main]
`

  test('becomes a service that is correct by construction', () => {
    const m = manifest(source)
    const db = m.services.find((s) => s.name === 'main')!
    assert.ok(db, 'the database should appear as a service')

    assert.equal(db.image, 'postgres:16')
    // Never published on the node's interface. A database reachable from the
    // whole LAN because a port was bound is the worst default available here.
    assert.equal(db.internal, true)
    // A volume does not move between machines, so neither may its service.
    assert.equal(db.placement, 'pinned')
    assert.equal(db.node, 'kakashi')
    assert.equal(db.volume, 'acme-main-data')
    assert.equal(db.volumePath, '/var/lib/postgresql/data')
    assert.equal(db.port, 5432)
    // The prober speaks HTTP and Postgres does not; a check it can never pass
    // means the rollout is never promoted and the deploy fails after ten
    // minutes for no reason anybody can see.
    assert.equal(db.health.disabled, true)
  })

  test('PGDATA is a subdirectory, or the first boot fails', () => {
    // Postgres refuses to initialise into a directory that is not empty, and a
    // freshly mounted volume contains lost+found. This is the whole reason the
    // hand-written version failed the first time.
    const db = manifest(source).services.find((s) => s.name === 'main')!
    assert.equal(db.env.PGDATA, '/var/lib/postgresql/data/pgdata')
    assert.notEqual(db.env.PGDATA, db.volumePath)
  })

  test('one credential, referenced from both sides', () => {
    const m = manifest(source)
    const db = m.services.find((s) => s.name === 'main')!
    const api = m.services.find((s) => s.name === 'api')!

    // The engine is created with it...
    assert.equal(db.env.POSTGRES_PASSWORD, '${secret:MAIN_PASSWORD}')
    assert.deepEqual(db.secrets, ['MAIN_PASSWORD'])
    // ...and the client connects with the same one. Two secrets a person types
    // twice is how they end up differing by a character.
    assert.match(String(api.env.DATABASE_URL), /\$\{secret:MAIN_PASSWORD\}/)
    assert.equal(api.env.DATABASE_PASSWORD, '${secret:MAIN_PASSWORD}')
  })

  test('a dependent service is pinned beside its database', () => {
    // Services resolve each other by name on the node's fleet network, and
    // that network does not span machines: an api scheduled elsewhere cannot
    // resolve "main" at all.
    const api = manifest(source).services.find((s) => s.name === 'api')!
    assert.equal(api.placement, 'pinned')
    assert.equal(api.node, 'kakashi')
    assert.ok(api.affinity.includes('main'))
  })

  test('the connection string is complete and usable', () => {
    const api = manifest(source).services.find((s) => s.name === 'api')!
    assert.equal(api.env.DATABASE_URL, 'postgres://postgres:${secret:MAIN_PASSWORD}@main:5432/main')
    assert.equal(api.env.DATABASE_HOST, 'main')
    assert.equal(api.env.DATABASE_PORT, '5432')
    assert.equal(api.env.DATABASE_NAME, 'main')
  })

  test('a hand-written value is never overwritten', () => {
    // Someone who wrote DATABASE_URL themselves meant it. Silently replacing
    // it would be the worst kind of magic.
    const m = manifest(`
fleet: homelab
databases:
  main: { engine: postgres, node: kakashi }
services:
  api:
    build: ./api
    uses: [main]
    env:
      DATABASE_URL: postgres://somewhere/else
`)
    const api = m.services.find((s) => s.name === 'api')!
    assert.equal(api.env.DATABASE_URL, 'postgres://somewhere/else')
    // The parts it did not write are still provided.
    assert.equal(api.env.DATABASE_HOST, 'main')
  })
})

describe('engines', () => {
  test('a bare engine name takes its default version', () => {
    assert.deepEqual(splitEngine('postgres'), { engine: 'postgres', version: null })
    assert.deepEqual(splitEngine('postgres@16'), { engine: 'postgres', version: '16' })
    assert.deepEqual(splitEngine('MySQL@8'), { engine: 'mysql', version: '8' })
  })

  test('redis is given no password, because it would not enforce one', () => {
    // Generating a credential the server ignores is a lie about how protected
    // the thing is. It stays internal instead, and says so.
    const spec = ENGINES.redis!
    assert.equal(spec.usesPassword, false)
    const url = connectionUrl(
      { name: 'cache', engine: 'redis', version: '7-alpine', node: 'n', database: 'cache', user: '' },
      spec
    )
    assert.equal(url, 'redis://cache:6379')
    assert.ok(!url.includes('secret:'), 'no credential should appear in a redis URL')
  })

  test('each engine mounts its own data directory', () => {
    // Mounting a volume at the wrong path gives an engine that starts happily
    // and loses everything on restart.
    assert.equal(ENGINES.postgres!.dataPath, '/var/lib/postgresql/data')
    assert.equal(ENGINES.mysql!.dataPath, '/var/lib/mysql')
    assert.equal(ENGINES.mongo!.dataPath, '/data/db')
    assert.equal(ENGINES.redis!.dataPath, '/data')
  })

  test('mysql reuses one password rather than inventing a second', () => {
    const db = expandDatabase(
      { name: 'main', engine: 'mysql', version: '8', node: 'n', database: 'app', user: 'app' },
      'acme'
    ) as { env: Record<string, string> }
    assert.equal(db.env.MYSQL_PASSWORD, db.env.MYSQL_ROOT_PASSWORD)
  })

  test('an unknown engine is refused, and lists the real ones', () => {
    assert.throws(
      () => manifest('fleet: h\ndatabases:\n  main: { engine: cockroach, node: n }\nservices:\n  a: { image: nginx }'),
      (err: unknown) => {
        assert.ok(err instanceof ManifestError)
        assert.match(err.issues[0]!.message, /postgres/)
        return true
      }
    )
  })
})

describe('naming', () => {
  test('volumes are scoped by project, so two clients never share one', () => {
    // Two agencies each with a database called "main" landing on one node must
    // not be handed the same volume.
    assert.equal(volumeNameFor('acme', 'main'), 'acme-main-data')
    assert.notEqual(volumeNameFor('acme', 'main'), volumeNameFor('globex', 'main'))
  })

  test('the secret name is derivable from the database name', () => {
    // So `fleet secrets ls` is readable and a person can replace one without
    // consulting anything.
    assert.equal(passwordRefFor('main'), 'MAIN_PASSWORD')
    assert.equal(passwordRefFor('user-db'), 'USER_DB_PASSWORD')
  })

  test('the first database gets the names frameworks already look for', () => {
    assert.equal(prefixFor('main', true), 'DATABASE')
    // A second one is named after itself rather than shadowing the first.
    assert.equal(prefixFor('analytics', false), 'ANALYTICS')
  })

  test('two databases do not collide in one service', () => {
    const m = manifest(`
fleet: homelab
databases:
  main: { engine: postgres, node: kakashi }
  cache: { engine: redis, node: kakashi }
services:
  api: { build: ./api, uses: [main, cache] }
`)
    const api = m.services.find((s) => s.name === 'api')!
    assert.equal(api.env.DATABASE_HOST, 'main')
    assert.equal(api.env.CACHE_HOST, 'cache')
    assert.equal(api.env.CACHE_URL, 'redis://cache:6379')
  })
})

describe('mistakes the manifest should catch', () => {
  test('a database and a service cannot share a name', () => {
    assert.throws(
      () => manifest('fleet: h\ndatabases:\n  api: { engine: postgres, node: n }\nservices:\n  api: { image: nginx }'),
      (err: unknown) => err instanceof ManifestError && /already a service/.test(err.issues[0]!.message)
    )
  })

  test('uses: naming something that is not a database says so', () => {
    assert.throws(
      () => manifest('fleet: h\nservices:\n  api: { image: nginx, uses: [nope] }'),
      (err: unknown) => err instanceof ManifestError && /not a database/.test(err.issues[0]!.message)
    )
  })

  test('pinning a service away from its database is refused', () => {
    // It would deploy, start, and fail every query with a DNS error — the
    // kind of failure that costs an afternoon.
    assert.throws(
      () =>
        manifest(`
fleet: homelab
databases:
  main: { engine: postgres, node: kakashi }
services:
  api: { build: ./api, uses: [main], placement: pinned, node: other }
`),
      (err: unknown) => err instanceof ManifestError && /same node/.test(err.issues[0]!.message)
    )
  })

  test('a database must say where its data lives', () => {
    assert.throws(
      () => manifest('fleet: h\ndatabases:\n  main: { engine: postgres }\nservices:\n  a: { image: nginx }'),
      ManifestError
    )
  })
})

describe('secret interpolation', () => {
  test('a composed value carries a secret without duplicating it', () => {
    const env = { DATABASE_URL: 'postgres://app:${secret:MAIN_PASSWORD}@main:5432/app' }
    assert.deepEqual(referencedSecrets(env), ['MAIN_PASSWORD'])
    const { env: out, unresolved } = interpolate(env, { MAIN_PASSWORD: 'hunter2' })
    assert.equal(out.DATABASE_URL, 'postgres://app:hunter2@main:5432/app')
    assert.deepEqual(unresolved, [])
  })

  test('an unresolved reference is reported, never blanked', () => {
    // Substituting an empty string produces a URL that looks plausible and
    // fails to authenticate somewhere far away from here.
    const { env, unresolved } = interpolate({ URL: 'postgres://a:${secret:MISSING}@h/d' }, {})
    assert.match(env.URL!, /\$\{secret:MISSING\}/)
    assert.deepEqual(unresolved, ['MISSING'])
  })

  test('one value may reference several secrets', () => {
    const { env } = interpolate(
      { PAIR: '${secret:A}:${secret:B}' },
      { A: 'one', B: 'two' }
    )
    assert.equal(env.PAIR, 'one:two')
  })

  test('a value with no reference is untouched', () => {
    const { env, unresolved } = interpolate({ PLAIN: 'nothing here $ or {braces}' }, {})
    assert.equal(env.PLAIN, 'nothing here $ or {braces}')
    assert.deepEqual(unresolved, [])
  })
})
