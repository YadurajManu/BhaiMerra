import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { applyEdits } from '../src/ai/edits.js'

const DRAFT = `fleet: homelab

services:
  api:
    build: ./api
    placement: flexible
    container_port: 3000
    resources: { ram: 512Mi, cpu: 0.5 }
    # No health check: container state decides whether this
    # is up. Add one once you know a path that returns 2xx.
    node: n1

  web:
    build: ./web
    placement: flexible
    container_port: 80
    resources: { ram: 512Mi, cpu: 0.5 }
`

describe('applying a review as edits', () => {
  test('changes what it names and nothing else', () => {
    const out = applyEdits(DRAFT, [
      { service: 'api', field: 'health', value: '/healthz', why: 'server.js defines it' },
    ])
    assert.equal(out.applied.length, 1)
    // Normalised: `health: /healthz` is what a model writes, and the
    // manifest wants `health: { path: /healthz }`.
    assert.match(out.manifest, /path: \/healthz/)
    assert.match(out.manifest, /build: \.\/web/, 'the service it was not shown is untouched')
  })

  test('keeps the comments init wrote', () => {
    // A generated file's comments are the only explanation it carries, and a
    // round-trip through parse and re-serialise destroys them.
    const out = applyEdits(DRAFT, [
      { service: 'api', field: 'container_port', value: 8000, why: 'EXPOSE 8000' },
    ])
    assert.match(out.manifest, /# No health check/)
  })

  test('refuses the fields a repository cannot decide', () => {
    // Each of these is a real incident: an invented node, a build swapped for
    // a public image.
    const out = applyEdits(DRAFT, [
      { service: 'api', field: 'node', value: 'mongo', why: 'compose has a mongo service' },
      { service: 'web', field: 'build', value: null, why: 'compose uses an image' },
    ])
    assert.equal(out.applied.length, 0)
    assert.equal(out.refused.length, 2)
    assert.match(out.manifest, /node: n1/, 'the manifest is unchanged')
    assert.match(out.manifest, /build: \.\/web/)
  })

  test('refuses a service that does not exist', () => {
    const out = applyEdits(DRAFT, [
      { service: 'ghost', field: 'container_port', value: 99, why: 'invented' },
    ])
    assert.equal(out.applied.length, 0)
    assert.match(out.refused[0]!.reason, /no service named/)
  })

  test('null removes a field', () => {
    // How a health check guessed onto a service that has no such route gets
    // taken back out.
    const out = applyEdits(
      DRAFT.replace('    node: n1', '    health: { path: / }\n    node: n1'),
      [{ service: 'api', field: 'health', value: null, why: 'no route at /' }]
    )
    assert.ok(!/health:/.test(out.manifest.split('web:')[0]!), 'gone from api')
  })
})
