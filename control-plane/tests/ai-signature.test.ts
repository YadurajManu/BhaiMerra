/**
 * Whether two failures are the same failure.
 *
 * This is the whole economics of the feature. Under-normalise and every deploy
 * has a unique signature, the cache never hits, and something that should cost
 * almost nothing charges for every build. Over-normalise and two different
 * problems share an answer, so the second reader is confidently told about the
 * first one's cause — which is worse than saying nothing.
 *
 * The fixtures are real buildx and npm output rather than invented strings,
 * because the noise is the point and invented noise is the noise I expected.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { normaliseLog, signatureOf, tail, worthExplaining, TAIL_LINES } from '../src/ai/signature.js'

/** The same broken lockfile, built twice. Everything incidental differs. */
const RUN_ONE = `
#12 [4/9] RUN npm ci
#12 sha256:9c1e2f3a4b5c6d7e8f9012345678abcd1234ef567890abcdef1234567890abcd
#12 0.412 npm error code EUSAGE
#12 0.418 npm error
#12 0.418 npm error \`npm ci\` can only install packages when your package.json and package-lock.json are in sync.
#12 0.419 npm error Missing: fastify@4.28.1 from lock file
#12 0.502 npm error A complete log of this run can be found in: /tmp/npm-cache-8f2a1b/_logs/2026-09-04T09_12_44_123Z-debug-0.log
#12 ERROR: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1
------
 > [4/9] RUN npm ci:
0.418 npm error \`npm ci\` can only install packages when your package.json and package-lock.json are in sync.
------
Dockerfile:9
--------------------
   8 |     COPY package*.json ./
   9 | >>> RUN npm ci
  10 |     COPY . .
--------------------
ERROR: failed to solve: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1
`

const RUN_TWO = `
#15 [4/9] RUN npm ci
#15 sha256:aa11bb22cc33dd44ee55ff6677889900aabbccddeeff00112233445566778899
#15 1.884 npm error code EUSAGE
#15 1.901 npm error
#15 1.901 npm error \`npm ci\` can only install packages when your package.json and package-lock.json are in sync.
#15 1.902 npm error Missing: fastify@4.28.1 from lock file
#15 2.140 npm error A complete log of this run can be found in: /tmp/npm-cache-c93f77/_logs/2026-09-04T11_48_02_991Z-debug-0.log
#15 ERROR: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1
------
 > [4/9] RUN npm ci:
1.901 npm error \`npm ci\` can only install packages when your package.json and package-lock.json are in sync.
------
Dockerfile:9
--------------------
   8 |     COPY package*.json ./
   9 | >>> RUN npm ci
  10 |     COPY . .
--------------------
ERROR: failed to solve: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1
`

/** A different problem entirely. */
const MISSING_BASE = `
#4 [1/9] FROM docker.io/library/node:22-alpine@sha256:1234abcd5678ef90
#4 ERROR: failed to resolve source metadata for docker.io/library/node:22-alpine: pull access denied, repository does not exist or may require authorization
ERROR: failed to solve: node:22-alpine: pull access denied
`

describe('the same failure twice', () => {
  test('collapses to one signature despite differing noise', () => {
    // Timestamps, step numbers, layer digests and scratch paths all differ.
    assert.notEqual(RUN_ONE, RUN_TWO, 'the fixtures really are different text')
    assert.equal(
      signatureOf(RUN_ONE),
      signatureOf(RUN_TWO),
      'two builds of the same broken lockfile must share a signature, or the cache never hits'
    )
  })

  test('the words that name the problem survive normalising', () => {
    const n = normaliseLog(RUN_ONE)
    // If these were stripped there would be nothing left to explain from.
    for (const kept of ['npm ci', 'package-lock.json', 'in sync', 'fastify', 'exit code: 1']) {
      assert.ok(n.includes(kept.toLowerCase()), `normalising must keep "${kept}"`)
    }
  })

  test('the noise that identifies one run does not', () => {
    const n = normaliseLog(RUN_ONE)
    for (const gone of ['9c1e2f3a4b5c', '2026-09-04t09_12_44', 'npm-cache-8f2a1b', '0.412']) {
      assert.ok(!n.includes(gone.toLowerCase()), `normalising must remove "${gone}"`)
    }
  })
})

describe('different failures stay different', () => {
  test('a missing base image is not a broken lockfile', () => {
    assert.notEqual(
      signatureOf(RUN_ONE),
      signatureOf(MISSING_BASE),
      'collapsing these would answer the wrong question confidently'
    )
  })

  test('two ports in the same message are two problems', () => {
    // The tempting over-normalisation. A port conflict on 8080 and one on 3000
    // have different fixes, and the number is the entire content of the fix.
    const a = 'Error: listen EADDRINUSE: address already in use :::8080\nat Server.setupListenHandle'
    const b = 'Error: listen EADDRINUSE: address already in use :::3000\nat Server.setupListenHandle'
    assert.notEqual(signatureOf(a), signatureOf(b))
  })

  test('two missing packages are two problems', () => {
    const a = 'npm error Missing: fastify@4.28.1 from lock file\nnpm error code EUSAGE'
    const b = 'npm error Missing: express@4.19.2 from lock file\nnpm error code EUSAGE'
    assert.notEqual(signatureOf(a), signatureOf(b))
  })
})

describe('tail', () => {
  test('keeps the end, where the cause is', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`)
    const got = tail(lines.join('\n')).split('\n')
    assert.equal(got.length, TAIL_LINES)
    assert.equal(got[got.length - 1], 'line 199')
  })

  test('a short log survives whole', () => {
    assert.equal(tail('a\nb\nc'), 'a\nb\nc')
  })
})

describe('worthExplaining', () => {
  test('a one-word status is not worth a model call', () => {
    // These are already the whole explanation; restating them costs money and
    // adds nothing.
    for (const reason of ['drift', 'node_down_pinned', '', null, undefined]) {
      assert.equal(worthExplaining(reason), false, String(reason))
    }
  })

  test('a real build log is', () => {
    assert.equal(worthExplaining(RUN_ONE), true)
  })
})
