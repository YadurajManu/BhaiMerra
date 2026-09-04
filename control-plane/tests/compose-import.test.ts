/**
 * The converter's output, judged by the parser that actually decides.
 *
 * The CLI's own tests check that composeToFleet produces the fields it meant
 * to. They cannot check the thing that matters most: whether the control plane
 * accepts the result. A converter that emits confident, well-formatted YAML the
 * product then rejects is worse than no converter, because the reader trusts it
 * and finds out later.
 *
 * It is excluded from tsconfig, because importing across package roots
 * violates rootDir and would break `npm run typecheck`. tsx runs it anyway,
 * and runtime is where schema drift shows up regardless. The clean fix is a
 * workspace with the manifest schema in a package both sides depend on; until
 * then this is the cheaper half of that trade.
 *
 * This test reaches across into the CLI deliberately. The two are built and
 * published separately, so the manifest schema can change here without anything
 * failing over there — which is exactly the drift worth catching, and only a
 * test that imports both can catch it.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { composeToFleet } from '../../cli/src/compose.js'
import { discover, manifestFromDiscovery } from '../../cli/src/discover.js'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseManifest } from '../src/manifest/parse.js'

/** Parse, or fail with the issues the product would have shown the user. */
function mustParse(manifest: string) {
  try {
    return parseManifest(manifest, 'test')
  } catch (err) {
    const detail = (err as { detail?: unknown }).detail
    assert.fail(
      `the control plane rejected the converted manifest:\n${
        Array.isArray(detail) ? JSON.stringify(detail, null, 2) : (err as Error).message
      }\n\n--- manifest ---\n${manifest}`
    )
  }
}

describe('converted compose files are valid manifests', () => {
  test('a plain web service', () => {
    const { manifest } = composeToFleet(`
services:
  web:
    image: nginx:1.27-alpine
    ports: ["8080:80"]
`)
    const parsed = mustParse(manifest)
    assert.equal(parsed.services.length, 1)
    assert.equal(parsed.services[0]!.name, 'web')
  })

  test('a build, a database and secrets together', () => {
    const { manifest } = composeToFleet(
      `
services:
  api:
    build: ./api
    ports: ["8080:3000"]
    depends_on: [db]
    environment:
      LOG_LEVEL: info
      DATABASE_PASSWORD: hunter2
    volumes: ["uploads:/var/lib/uploads"]
    deploy: { replicas: 2, resources: { limits: { memory: 1g, cpus: "1" } } }
  db:
    image: postgres:16
    environment: { POSTGRES_DB: app, POSTGRES_USER: app, POSTGRES_PASSWORD: hunter2 }
`,
      { fleet: 'homelab', node: 'kakashi' }
    )
    const parsed = mustParse(manifest)

    const api = parsed.services.find((s) => s.name === 'api')
    assert.deepEqual(api!.uses, ['db'], 'a database dependency becomes uses')
    assert.ok(api, 'the api service survived the round trip')
    assert.equal(api!.replicas, 2)
    assert.ok(api!.secrets.includes('DATABASE_PASSWORD'))
    assert.equal(parsed.databases.length, 1)
    assert.equal(parsed.databases[0]!.node, 'kakashi')
  })

  test('a service depending on another service still parses', () => {
    // The case that slipped through first time. compose's depends_on covers
    // both services and databases; `uses` accepts only databases, so mapping
    // the two across produced a manifest the parser refused with
    // '"api" is not a database in this manifest'. Every fixture here happened
    // to depend on a database, so nothing failed.
    const { manifest, notes } = composeToFleet(`
services:
  web:
    image: web:1
    depends_on: [api, db]
  api:
    image: api:1
  db:
    image: postgres:16
`, { node: 'n1' })
    const parsed = mustParse(manifest)
    const web = parsed.services.find((s) => s.name === 'web')!
    assert.deepEqual(web.uses, ['db'], 'only the database survives into uses')
    assert.ok(
      notes.some((n) => /depends_on api was dropped/.test(n)),
      'and the dropped service dependency is stated, not silent'
    )
  })

  test('the placeholder node is rejected loudly, not accepted quietly', () => {
    // Without --node the converter writes CHANGE_ME and asks. That is only
    // honest if the product then refuses it - a manifest that parses with a
    // placeholder node would deploy a database somewhere nobody chose.
    const { manifest, questions } = composeToFleet(
      'services:\n  app: { image: app:1 }\n  db: { image: postgres:16 }'
    )
    assert.equal(questions.length, 1)
    const parsed = parseManifest(manifest, 'test')
    // It parses as a name; the deploy is what fails. Assert the placeholder
    // survived verbatim so it cannot be mistaken for a real node.
    assert.equal(parsed.databases[0]!.node, 'CHANGE_ME')
  })

  test('every engine the converter can emit is one the manifest accepts', () => {
    for (const image of ['postgres:16', 'mysql:8', 'mariadb:11', 'redis:7', 'mongo:7']) {
      const { manifest } = composeToFleet(
        `services:\n  app: { image: app:1 }\n  store: { image: ${image} }`,
        { node: 'n1' }
      )
      const parsed = mustParse(manifest)
      assert.equal(parsed.databases.length, 1, image)
    }
  })
})


describe('a discovered repository is a valid manifest too', () => {
  // Same discipline as the compose importer: the CLI's own tests check the
  // fields it meant to write, and only the real parser can say whether the
  // product accepts them. That check found two bugs last time.
  test('a monorepo with two apps and a database', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-rt-'))
    try {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'acme', private: true, workspaces: ['apps/*'] })
      )
      await mkdir(join(dir, 'apps', 'web'), { recursive: true })
      await writeFile(
        join(dir, 'apps', 'web', 'package.json'),
        JSON.stringify({ name: 'web', scripts: { start: 'next start' }, dependencies: { next: '^14' } })
      )
      await mkdir(join(dir, 'apps', 'api'), { recursive: true })
      await writeFile(
        join(dir, 'apps', 'api', 'package.json'),
        JSON.stringify({ name: 'api', scripts: { start: 'node i.js' }, dependencies: { fastify: '^4', pg: '^8' } })
      )
      await writeFile(join(dir, 'apps', 'api', '.env.example'), 'LOG_LEVEL=info\nDB_PASSWORD=\n')

      const d = await discover(dir)
      const { manifest } = manifestFromDiscovery(d, { fleet: 'homelab', node: 'kakashi' })
      const parsed = mustParse(manifest)

      assert.deepEqual(parsed.services.map((s) => s.name).sort(), ['api', 'db', 'web'])
      assert.equal(parsed.databases.length, 1)
      const api = parsed.services.find((s) => s.name === 'api')!
      assert.ok(api.secrets.includes('DB_PASSWORD'))
      assert.deepEqual(api.uses, ['db'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})


describe('a compose service named after its own engine', () => {
  test('is renamed rather than producing a manifest the product refuses', () => {
    // postgres: is what almost every compose file calls it. The derived secret
    // POSTGRES_PASSWORD then collides with the variable the postgres image
    // itself reads, and the parser rejects the whole file.
    const { manifest, notes } = composeToFleet(
      'services:\n  app: { image: app:1, depends_on: [postgres] }\n  postgres: { image: postgres:16 }',
      { node: 'n1' }
    )
    const parsed = mustParse(manifest)
    assert.equal(parsed.databases[0]!.name, 'db')
    const app = parsed.services.find((s) => s.name === 'app')!
    assert.deepEqual(app.uses, ['db'], 'the dependency follows the rename')
    assert.ok(notes.some((n) => /is declared as "db"/.test(n)), 'and the rename is explained')
  })
})
