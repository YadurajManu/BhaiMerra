import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { repositoryOf } from '../src/build/buildx.js'
import { platformsFor } from '../src/build/runner.js'

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
