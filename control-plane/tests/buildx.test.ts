import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { repositoryOf, containedContext } from '../src/build/buildx.js'
import { platformsFor, BuildUnavailableError } from '../src/build/runner.js'

describe('image reference handling', () => {
  test('a registry port is not mistaken for a tag', () => {
    // Splitting on the first colon yields "localhost", which resolves to
    // Docker Hub — the build then fails with an authorization error that
    // says nothing about the real cause.
    assert.equal(repositoryOf('localhost:5001/hello:4f1c9ae'), 'localhost:5001/hello')
    assert.equal(repositoryOf('localhost:5001/hello'), 'localhost:5001/hello')
    assert.equal(repositoryOf('registry.internal:443/team/app:v1'), 'registry.internal:443/team/app')
  })

  test('ordinary references still work', () => {
    assert.equal(repositoryOf('ghcr.io/you/app:v2'), 'ghcr.io/you/app')
    assert.equal(repositoryOf('nginx:1.27'), 'nginx')
    assert.equal(repositoryOf('nginx'), 'nginx')
  })
})

describe('platform mapping (FR-3)', () => {
  test('maps the fleet architectures onto buildx platforms', () => {
    assert.deepEqual(platformsFor(['arm64', 'amd64', 'armv7']), [
      'linux/arm64',
      'linux/amd64',
      'linux/arm/v7',
    ])
  })

  test('deduplicates so a fleet of eight amd64 boxes builds one platform', () => {
    assert.deepEqual(platformsFor(['amd64', 'amd64', 'amd64']), ['linux/amd64'])
  })

  test('drops architectures with no buildx equivalent rather than passing them through', () => {
    assert.deepEqual(platformsFor(['arm64', 'sparc']), ['linux/arm64'])
  })
})

describe('resolving a build context', () => {
  test('an upload is the context itself', () => {
    // The CLI resolved `build: ./PlasticWorld` against the manifest directory
    // before packing, so the archive root is already the directory to build.
    // Joining the path on again looked for ./PlasticWorld inside itself, which
    // is exactly the failure this pins down.
    assert.equal(
      containedContext('/var/lib/fleet-os/builds/uploads/abc', '.'),
      '/var/lib/fleet-os/builds/uploads/abc'
    )
  })

  test('a checkout is a repository, and the path selects a directory inside it', () => {
    assert.equal(
      containedContext('/var/lib/fleet-os/builds/checkouts/xyz', './PlasticWorld'),
      '/var/lib/fleet-os/builds/checkouts/xyz/PlasticWorld'
    )
  })

  test('a context that climbs out of its root is refused', () => {
    // A manifest is user input; "build: ../../../etc" must not read the host.
    assert.throws(
      () => containedContext('/var/lib/fleet-os/builds/uploads/abc', '../../../etc'),
      BuildUnavailableError
    )
    assert.throws(() => containedContext('/var/lib/fleet-os/builds', '..'), BuildUnavailableError)
  })

  test('a sibling sharing a name prefix is not inside the root', () => {
    // /var/lib/root-evil starts with /var/lib/root but is not under it; a
    // startsWith check without the separator would let it through.
    assert.throws(() => containedContext('/var/lib/root', '../root-evil'), BuildUnavailableError)
  })
})
