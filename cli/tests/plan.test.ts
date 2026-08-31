import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { planFromManifest, deployOrder } from '../src/plan.js'
import { ignorePatterns } from '../src/archive.js'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STACK = `
fleet: homelab
services:
  postgres:
    image: postgres:16
    internal: true
  redis:
    image: redis:7
    internal: true
  api:
    build: ./PlasticWorld
    affinity: [postgres, redis]
  website:
    build: ./product-website
`

describe('reading the manifest', () => {
  test('finds every service, and which of them build from source', () => {
    const plan = planFromManifest(STACK)
    assert.deepEqual(
      plan.map((s) => s.name),
      ['postgres', 'redis', 'api', 'website']
    )
    assert.equal(plan.find((s) => s.name === 'api')?.build, './PlasticWorld')
    // A prebuilt image has no context to send, and uploading one would be waste.
    assert.equal(plan.find((s) => s.name === 'postgres')?.build, undefined)
  })

  test('a manifest with no services plans nothing rather than throwing', () => {
    // The server validates; this only decides what to send.
    assert.deepEqual(planFromManifest('fleet: homelab\n'), [])
    assert.deepEqual(planFromManifest(''), [])
  })
})

describe('deploy order', () => {
  test('a dependency is deployed before what depends on it', () => {
    const order = deployOrder(planFromManifest(STACK))
    assert.ok(
      order.indexOf('postgres') < order.indexOf('api'),
      `postgres must precede api, got ${order.join(' → ')}`
    )
    assert.ok(order.indexOf('redis') < order.indexOf('api'))
  })

  test('every service is deployed, not just the ones with edges', () => {
    const order = deployOrder(planFromManifest(STACK))
    assert.equal(order.length, 4)
    assert.ok(order.includes('website'))
  })

  test('services with no relationship keep manifest order', () => {
    // The file stays the explanation for what happens.
    const order = deployOrder(
      planFromManifest(`
fleet: homelab
services:
  alpha: { image: a }
  beta: { image: b }
  gamma: { image: c }
`)
    )
    assert.deepEqual(order, ['alpha', 'beta', 'gamma'])
  })

  test('a cycle still deploys everything instead of refusing', () => {
    // Refusing to deploy is a worse answer than an imperfect order.
    const order = deployOrder(
      planFromManifest(`
fleet: homelab
services:
  a:
    image: a
    affinity: [b]
  b:
    image: b
    affinity: [a]
`)
    )
    assert.equal(order.length, 2)
    assert.ok(order.includes('a') && order.includes('b'))
  })

  test('affinity on a service outside the manifest is ignored', () => {
    const order = deployOrder(
      planFromManifest(`
fleet: homelab
services:
  web:
    image: nginx
    affinity: [something-else]
`)
    )
    assert.deepEqual(order, ['web'])
  })
})

describe('packing a build context', () => {
  test('always excludes what is never part of an image', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-ctx-'))
    const patterns = await ignorePatterns(dir)
    // These are the difference between a 200kB upload and a 200MB one.
    for (const expected of ['.git', 'node_modules']) {
      assert.ok(patterns.includes(expected), `${expected} should always be excluded`)
    }
  })

  test('honours .dockerignore on top of those', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-ctx-'))
    await writeFile(join(dir, '.dockerignore'), '# a comment\ndist\n\nlogs/\n/coverage\n')
    const patterns = await ignorePatterns(dir)

    assert.ok(patterns.includes('dist'))
    // Trailing and leading slashes are trimmed so tar matches them.
    assert.ok(patterns.includes('logs'))
    assert.ok(patterns.includes('coverage'))
    assert.ok(!patterns.includes('# a comment'))
    assert.ok(!patterns.includes(''))
  })

  test('negations are dropped rather than half-implemented', async () => {
    // Including a file that should have been excluded is a slow upload.
    // Excluding one that should have been kept is a broken build, so a
    // pattern this cannot honour exactly is not honoured at all.
    const dir = await mkdtemp(join(tmpdir(), 'fleet-ctx-'))
    await writeFile(join(dir, '.dockerignore'), 'dist\n!dist/keep.js\n')
    const patterns = await ignorePatterns(dir)
    assert.ok(patterns.includes('dist'))
    assert.ok(!patterns.some((p) => p.startsWith('!')))
  })
})
