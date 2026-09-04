/**
 * Reading a repository and saying what it deploys.
 *
 * Every fixture here is a real directory tree on disk, because the thing being
 * tested is reading directory trees. A mocked filesystem would pass while the
 * real one returned nothing, which is the only failure mode that matters.
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

import { discover, manifestFromDiscovery } from '../src/discover.js'

let root: string

/** Write a file, creating parents. */
async function put(rel: string, body: string) {
  const path = join(root, rel)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, body)
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'fleet-discover-'))
})
after(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('a single-project repository', () => {
  let dir: string
  before(async () => {
    dir = join(root, 'single')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      name: 'shop',
      scripts: { start: 'node server.js' },
      dependencies: { express: '^4', pg: '^8', ioredis: '^5' },
    }))
    await writeFile(join(dir, '.env.example'), [
      '# how it is configured',
      'LOG_LEVEL=info',
      'PORT=3000',
      'DATABASE_PASSWORD=',
      'STRIPE_API_KEY=',
      '',
    ].join('\n'))
  })

  test('finds one service and both databases', async () => {
    const d = await discover(dir)
    assert.equal(d.layout, null, 'no workspaces declared')
    assert.equal(d.services.length, 1)
    assert.equal(d.services[0]!.dir, '.')
    assert.deepEqual(
      d.databases.map((x) => x.engine).sort(),
      ['postgres', 'redis'],
      'pg and ioredis are facts, not guesses'
    )
  })

  test('separates settings from credentials', async () => {
    const d = await discover(dir)
    const s = d.services[0]!
    assert.deepEqual(s.env.sort(), ['LOG_LEVEL', 'PORT'])
    assert.deepEqual(s.secrets.sort(), ['DATABASE_PASSWORD', 'STRIPE_API_KEY'])
    // A credential must never be written into a file people commit.
    const { manifest } = manifestFromDiscovery(d, { node: 'n1' })
    assert.ok(manifest.includes('secrets: [DATABASE_PASSWORD, STRIPE_API_KEY]'))
    assert.ok(!/DATABASE_PASSWORD:\s/.test(manifest))
  })
})

describe('an npm-workspaces monorepo', () => {
  let dir: string
  before(async () => {
    dir = join(root, 'mono')
    await mkdir(dir, { recursive: true })
    root = dir // put() writes relative to root
    await put('package.json', JSON.stringify({ name: 'acme', private: true, workspaces: ['apps/*', 'packages/*'] }))

    await put('apps/web/package.json', JSON.stringify({
      name: 'web', scripts: { start: 'next start' }, dependencies: { next: '^14' },
    }))
    await put('apps/api/package.json', JSON.stringify({
      name: 'api', scripts: { start: 'node index.js' }, dependencies: { fastify: '^4', pg: '^8' },
    }))
    // A library: no start script, no Dockerfile. Deploying it is nonsense.
    await put('packages/types/package.json', JSON.stringify({
      name: 'types', dependencies: { zod: '^3' },
    }))
    await put('apps/worker/Dockerfile', 'FROM python:3.12\nEXPOSE 9000\nCMD ["python","w.py"]\n')
    await put('apps/worker/requirements.txt', 'celery==5.3\ntorch==2.4\n')
  })

  test('finds every deployable package and skips the library', async () => {
    const d = await discover(dir)
    assert.equal(d.layout, 'npm workspaces')
    const names = d.services.map((s) => s.name).sort()
    assert.deepEqual(names, ['api', 'web', 'worker'])
    assert.ok(!names.includes('types'), 'a package with no way to start is not a service')
  })

  test('does not invent a service for the workspace root', async () => {
    const d = await discover(dir)
    // The root package.json exists only to declare workspaces. Treating it as
    // a service adds a phantom named after the repository.
    assert.ok(!d.services.some((s) => s.dir === '.'), 'the root is not a service')
  })

  test('an ML dependency asks for a GPU and more memory', async () => {
    const d = await discover(dir)
    const worker = d.services.find((s) => s.name === 'worker')!
    assert.match(worker.gpu ?? '', /torch/)
    assert.equal(worker.ramMb, 4096, 'a model needs more than the default')

    const { manifest, questions } = manifestFromDiscovery(d, { node: 'n1' })
    assert.ok(manifest.includes('gpu: true'))
    // Asking for a GPU is a strong claim, so it is flagged rather than assumed
    // correct.
    assert.ok(questions.some((q) => /remove "gpu: true"/.test(q)))
  })

  test('reads the port out of an existing Dockerfile', async () => {
    const d = await discover(dir)
    const worker = d.services.find((s) => s.name === 'worker')!
    assert.equal(worker.detection.port, 9000, 'EXPOSE 9000')
  })

  test('databases are collected across every package, not just one', async () => {
    const d = await discover(dir)
    const engines = d.databases.map((x) => x.engine).sort()
    // pg lives in apps/api, celery in apps/worker; neither package alone
    // declares both.
    assert.deepEqual(engines, ['postgres', 'redis'])
  })

  test('the manifest it renders is valid YAML with every service', async () => {
    const d = await discover(dir)
    const { manifest } = manifestFromDiscovery(d, { fleet: 'homelab', node: 'kakashi' })
    const doc = parseYaml(manifest)
    assert.equal(doc.fleet, 'homelab')
    assert.deepEqual(Object.keys(doc.services).sort(), ['api', 'web', 'worker'])
    // Named for what they are to the reader, not after their images: a
    // database called `postgres` derives POSTGRES_PASSWORD, which collides
    // with the engine's own variable and the manifest is rejected.
    assert.deepEqual(Object.keys(doc.databases).sort(), ['cache', 'db'])
    assert.equal(doc.databases.db.engine, 'postgres')
    assert.equal(doc.databases.db.node, 'kakashi')
    // api declares pg; web declares only next. A frontend that never talks to
    // the database must not claim it does.
    assert.deepEqual(doc.services.api.uses, ['db'])
    assert.equal(doc.services.web.uses, undefined)
  })

  test('without --node it asks instead of choosing a machine', async () => {
    const d = await discover(dir)
    const { manifest, questions } = manifestFromDiscovery(d)
    assert.match(manifest, /node: CHANGE_ME/)
    assert.ok(questions.some((q) => /must name the node/.test(q)))
  })
})

describe('conventions without a workspace file', () => {
  test('an apps/ directory is recognised on its own', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-conv-'))
    await mkdir(join(dir, 'apps', 'site'), { recursive: true })
    await writeFile(join(dir, 'apps', 'site', 'Dockerfile'), 'FROM nginx\nEXPOSE 8080\n')

    const d = await discover(dir)
    assert.equal(d.layout, 'directories that look like services')
    assert.deepEqual(d.services.map((s) => s.name), ['site'])
    await rm(dir, { recursive: true, force: true })
  })

  test('backend/ beside a frontend is found too', async () => {
    // Neither is under apps/ or services/, and nothing declares a workspace.
    // A real project in exactly this shape was read as one unrecognised
    // project, because only the apps/-style layout was being looked for.
    const dir = await mkdtemp(join(tmpdir(), 'fleet-two-'))
    await mkdir(join(dir, 'backend'), { recursive: true })
    await writeFile(
      join(dir, 'backend', 'package.json'),
      JSON.stringify({ name: 'backend', scripts: { start: 'nest start' }, dependencies: { '@nestjs/core': '^10', '@prisma/client': '^5' } })
    )
    await mkdir(join(dir, 'landing_page'), { recursive: true })
    await writeFile(
      join(dir, 'landing_page', 'package.json'),
      JSON.stringify({ name: 'site', scripts: { build: 'vite build' }, dependencies: { vite: '^5' } })
    )
    await mkdir(join(dir, 'documentation'), { recursive: true })

    const d = await discover(dir)
    // Underscores become hyphens: a service name ends up in a hostname.
    assert.deepEqual(d.services.map((s) => s.name).sort(), ['backend', 'landing-page'])
    // A folder of documents is not a service.
    assert.ok(!d.services.some((s) => s.name === 'documentation'))
    assert.deepEqual(d.databases.map((x) => x.engine), ['postgres'], 'prisma implies postgres')
    await rm(dir, { recursive: true, force: true })
  })

  test('an empty directory is reported, not guessed at', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-empty-'))
    const d = await discover(dir)
    assert.equal(d.services.length, 0)
    assert.ok(d.notes.some((n) => /nothing deployable/.test(n)))
    await rm(dir, { recursive: true, force: true })
  })
})

/**
 * A guessed health path is not a harmless default.
 *
 * When it is wrong the probe fails for ever, and the deploy never leaves
 * "deploying" even though the container is running and serving traffic
 * correctly. No check at all is strictly better: container state decides and
 * the service comes up. So the generator only writes one where the framework
 * genuinely answers there.
 */
describe('generated health checks', () => {
  test('a backend API gets no invented health path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-health-api-'))
    await mkdir(join(dir, 'backend'), { recursive: true })
    await writeFile(
      join(dir, 'backend', 'package.json'),
      JSON.stringify({ name: 'backend', scripts: { start: 'nest start' }, dependencies: { '@nestjs/core': '^10' } })
    )

    const d = await discover(dir)
    const { manifest } = manifestFromDiscovery(d, {})

    assert.ok(
      !/^\s+health: \{ path:/m.test(manifest),
      'a NestJS app has no /health unless somebody wrote one; guessing it strands the deploy'
    )
    assert.match(manifest, /# No health check/, 'the absence should be explained, not silent')
    await rm(dir, { recursive: true, force: true })
  })

  test('a frontend keeps the health check it actually answers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-health-web-'))
    await mkdir(join(dir, 'site'), { recursive: true })
    await writeFile(
      join(dir, 'site', 'package.json'),
      JSON.stringify({ name: 'site', scripts: { build: 'vite build' }, dependencies: { vite: '^5' } })
    )

    const d = await discover(dir)
    const { manifest } = manifestFromDiscovery(d, {})

    // A built Vite app is served at the root, so this one is not a guess.
    assert.match(manifest, /^\s+health: \{ path: \/ \}/m)
    await rm(dir, { recursive: true, force: true })
  })

  test('a project with its own Dockerfile is not assumed to serve /', async () => {
    // The case that stranded MedLifeCycle: an existing Dockerfile tells us
    // nothing about routing, and its API answered 404 at / behind a global
    // prefix.
    const dir = await mkdtemp(join(tmpdir(), 'fleet-health-dockerfile-'))
    await mkdir(join(dir, 'api'), { recursive: true })
    await writeFile(join(dir, 'api', 'Dockerfile'), 'FROM node:20-bookworm-slim\nEXPOSE 3100\n')
    await writeFile(join(dir, 'api', 'package.json'), JSON.stringify({ name: 'api', scripts: { start: 'node main.js' } }))

    const d = await discover(dir)
    const { manifest } = manifestFromDiscovery(d, {})

    assert.ok(
      !/^\s+health: \{ path:/m.test(manifest),
      'an existing Dockerfile says nothing about which paths return 2xx'
    )
    await rm(dir, { recursive: true, force: true })
  })
})

describe('generated container ports', () => {
  test('port 80 is written out rather than left to a default that is not 80', async () => {
    // Omitting it does not mean 80. An unset container port becomes 8080 on
    // the node, so an nginx image serving 80 had its traffic forwarded to a
    // closed port: a 502 behind a service every status called "running".
    const dir = await mkdtemp(join(tmpdir(), 'fleet-port-'))
    await mkdir(join(dir, 'site'), { recursive: true })
    await writeFile(join(dir, 'site', 'index.html'), '<!doctype html><title>hi</title>')

    const d = await discover(dir)
    const { manifest } = manifestFromDiscovery(d, {})

    assert.match(manifest, /^\s+container_port: 80$/m)
    await rm(dir, { recursive: true, force: true })
  })
})
