import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseManifest, parseQuantityMb, ManifestError } from '../src/manifest/parse.js'

const VALID = `
fleet: homelab

defaults:
  reclaim: idle

services:
  web:
    build: ./apps/web
    placement: flexible
    resources: { ram: 512Mi, cpu: 0.5 }
    domain: web.yourdomain.dev
    anti_affinity: [img-proxy]

  img-proxy:
    build: ./apps/imgproxy
    resources: { ram: 768Mi }

  postgres:
    image: postgres:16
    placement: pinned
    node: node-03
    volume: pgdata
    secrets: [POSTGRES_PASSWORD]
`

const expectError = (yaml: string): ManifestError => {
  try {
    parseManifest(yaml)
  } catch (err) {
    assert.ok(err instanceof ManifestError, `expected ManifestError, got ${err}`)
    return err
  }
  throw new Error('expected the manifest to be rejected, but it parsed')
}

describe('quantity parsing', () => {
  test('understands binary and decimal units', () => {
    assert.equal(parseQuantityMb('512Mi'), 512)
    assert.equal(parseQuantityMb('2Gi'), 2048)
    assert.equal(parseQuantityMb('1G'), 1000)
    assert.equal(parseQuantityMb('1Ti'), 1024 * 1024)
  })

  test('a bare number means megabytes', () => {
    assert.equal(parseQuantityMb('512'), 512)
    assert.equal(parseQuantityMb(512), 512)
  })

  test('rejects nonsense rather than guessing', () => {
    for (const bad of ['', 'lots', '512MB!', '-5Gi', 'Gi']) {
      assert.equal(parseQuantityMb(bad), null, `"${bad}" should be rejected`)
    }
  })
})

describe('a valid manifest', () => {
  test('parses every service', () => {
    const m = parseManifest(VALID)
    assert.equal(m.fleet, 'homelab')
    assert.deepEqual(m.services.map((s) => s.name).sort(), ['img-proxy', 'postgres', 'web'])
  })

  test('applies defaults and lets a service override them', () => {
    const m = parseManifest(`
fleet: homelab
defaults:
  resources: { ram: 128Mi }
  placement: flexible
services:
  small: { build: ./a }
  big:   { build: ./b, resources: { ram: 4Gi } }
`)
    const byName = Object.fromEntries(m.services.map((s) => [s.name, s]))
    assert.equal(byName['small']!.resources.ram, 128)
    assert.equal(byName['big']!.resources.ram, 4096)
  })

  test('keeps a repository URL for push-triggered deploys', () => {
    const { services } = parseManifest(`
fleet: homelab
services:
  web:
    repo: https://github.com/you/homelab.git
    build: ./web
`)
    assert.equal(services[0]!.repo, 'https://github.com/you/homelab.git')
  })

  test('fills in sane defaults for everything omitted', () => {
    const [svc] = parseManifest(`
fleet: f
services:
  minimal: { build: . }
`).services
    assert.equal(svc!.placement, 'flexible')
    assert.equal(svc!.resources.ram, 256)
    assert.equal(svc!.replicas, 1)
    assert.equal(svc!.health.path, '/')
    assert.deepEqual(svc!.arch, [], 'no arch means any architecture')
  })
})

describe('rejections are specific (FR-4)', () => {
  test('reports every problem at once, not one per deploy', () => {
    const err = expectError(`
fleet: homelab
services:
  a: { placement: pinned }
  b: { build: ./b, image: nginx }
  c: {}
`)
    assert.ok(err.issues.length >= 3, `expected several issues, got ${err.issues.length}`)
    const paths = err.issues.map((i) => i.path)
    assert.ok(paths.some((p) => p.startsWith('services.a')))
    assert.ok(paths.some((p) => p.startsWith('services.b')))
    assert.ok(paths.some((p) => p.startsWith('services.c')))
  })

  test('names the fix, not just the failure', () => {
    const err = expectError(`
fleet: f
services:
  db: { image: postgres:16, placement: pinned }
`)
    assert.match(err.issues[0]!.message, /requires "node"/)
  })

  test('build and image together is a real ambiguity, not a merge', () => {
    const err = expectError(`
fleet: f
services:
  web: { build: ./web, image: nginx:latest }
`)
    assert.match(err.issues[0]!.message, /not both/)
  })

  test('a service with neither build nor image cannot deploy', () => {
    const err = expectError(`
fleet: f
services:
  ghost: { placement: flexible }
`)
    assert.match(err.issues[0]!.message, /either "build".*or "image"/)
  })

  test('invalid service names are caught with the rule stated', () => {
    const err = expectError(`
fleet: f
services:
  "My_Service": { build: . }
`)
    assert.match(err.issues[0]!.message, /lowercase letters, digits and hyphens/)
  })

  test('affinity pointing at a non-existent service is an error', () => {
    const err = expectError(`
fleet: f
services:
  web: { build: ./w, affinity: [cache] }
`)
    assert.match(err.issues[0]!.message, /"cache" is not a service in this manifest/)
  })

  test('a service cannot be anti-affine with itself', () => {
    const err = expectError(`
fleet: f
services:
  web: { build: ./w, anti_affinity: [web] }
`)
    assert.match(err.issues[0]!.message, /cannot have anti_affinity with itself/)
  })

  test('a bad size names the value and the accepted forms', () => {
    const err = expectError(`
fleet: f
services:
  web: { build: ./w, resources: { ram: "loads" } }
`)
    assert.match(err.issues[0]!.message, /"loads" is not a valid size/)
    assert.match(err.issues[0]!.message, /512Mi/)
  })

  test('malformed YAML is reported as such, not as a schema failure', () => {
    const err = expectError('fleet: [unclosed\n  services:')
    assert.equal(err.issues[0]!.path, 'fleet.yaml')
  })

  test('an empty file says what is missing', () => {
    assert.match(expectError('').issues[0]!.message, /empty|not a YAML mapping/)
  })

  test('a manifest with no services has nothing to do', () => {
    assert.match(expectError('fleet: f\nservices: {}').issues[0]!.message, /nothing to deploy/)
  })
})

describe('warnings (FR-18) — allowed, but never silent', () => {
  test('a volume on a flexible service warns about data not moving', () => {
    const m = parseManifest(`
fleet: f
services:
  db: { image: postgres:16, volume: pgdata, placement: flexible }
`)
    assert.equal(m.warnings.length, 1)
    assert.match(m.warnings[0]!, /Volumes do not move between machines/)
  })

  test('a pinned service with a volume is correct and warns about nothing', () => {
    const m = parseManifest(`
fleet: f
services:
  db: { image: postgres:16, volume: pgdata, placement: pinned, node: node-03 }
`)
    assert.deepEqual(m.warnings, [])
  })

  test('replicas sharing one volume are refused, and the file says so', () => {
    // This used to warn that concurrent writers "will corrupt data" — a
    // prediction about something that would then happen anyway, because
    // nothing acted on replicas at all. The scaler now declines to scale a
    // service holding a volume, so the manifest states that outcome instead
    // of forecasting a disaster it is actually preventing.
    const m = parseManifest(`
fleet: f
services:
  db: { image: postgres:16, volume: pgdata, placement: pinned, node: n1, replicas: 3 }
`)
    assert.ok(
      m.warnings.some((w) => /will not scale it/.test(w)),
      `expected a warning that it will not be scaled, got: ${m.warnings.join(' | ')}`
    )
    assert.ok(m.warnings.some((w) => /single copy/.test(w)))
  })
})
