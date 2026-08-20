import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

import { hashPassword, verifyPassword } from '../src/auth/passwords.js'
import { sealSecret, openSecret } from '../src/lib/crypto.js'
import { newAgentToken, newPairingToken, hashToken, tokenMatches, isAgentToken, isPairingToken } from '../src/lib/tokens.js'
import { can, atLeast } from '../src/auth/rbac.js'

const masterKey = () => randomBytes(32).toString('base64')

describe('password hashing', () => {
  test('verifies the correct password and rejects a wrong one', async () => {
    const digest = await hashPassword('correct horse battery staple')
    assert.ok(digest.startsWith('$argon2id$'), 'should be argon2id')
    assert.equal(await verifyPassword(digest, 'correct horse battery staple'), true)
    assert.equal(await verifyPassword(digest, 'Correct horse battery staple'), false)
  })

  test('a malformed digest is a failed login, not a throw', async () => {
    assert.equal(await verifyPassword('not-a-digest', 'anything'), false)
    assert.equal(await verifyPassword('', ''), false)
  })

  test('the same password hashes differently each time', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')])
    assert.notEqual(a, b, 'salt must differ')
  })
})

describe('secret envelope encryption (FR-13)', () => {
  test('round-trips a value', () => {
    const mk = masterKey()
    const value = 'postgres://user:hunter2@db.internal:5432/prod'
    assert.equal(openSecret(sealSecret(value, mk), mk), value)
  })

  test('never stores the plaintext in the envelope', () => {
    const mk = masterKey()
    const sealed = sealSecret('SUPER_SECRET_VALUE', mk)
    assert.ok(!JSON.stringify(sealed).includes('SUPER_SECRET_VALUE'))
  })

  test('a different master key cannot open it', () => {
    const sealed = sealSecret('value', masterKey())
    assert.throws(() => openSecret(sealed, masterKey()))
  })

  test('tampering with the ciphertext is detected', () => {
    const mk = masterKey()
    const sealed = sealSecret('value', mk)
    const bytes = Buffer.from(sealed.ciphertext, 'base64')
    bytes.writeUInt8(bytes.readUInt8(0) ^ 0xff, 0)
    assert.throws(
      () => openSecret({ ...sealed, ciphertext: bytes.toString('base64') }, mk),
      /unable to authenticate|unsupported state/i
    )
  })

  test('each secret gets its own data key', () => {
    const mk = masterKey()
    const a = sealSecret('value', mk)
    const b = sealSecret('value', mk)
    assert.notEqual(a.wrappedDek, b.wrappedDek)
    assert.notEqual(a.ciphertext, b.ciphertext, 'identical plaintext must not produce identical ciphertext')
  })

  test('rejects a master key that is not 32 bytes', () => {
    assert.throws(() => sealSecret('v', Buffer.alloc(16).toString('base64')), /32 bytes/)
  })
})

describe('agent and pairing tokens', () => {
  test('tokens are prefixed so their kind is obvious in a log', () => {
    assert.ok(isAgentToken(newAgentToken()))
    assert.ok(isPairingToken(newPairingToken()))
    assert.ok(!isAgentToken(newPairingToken()))
  })

  test('matches its own hash and nothing else', () => {
    const token = newAgentToken()
    assert.equal(tokenMatches(token, hashToken(token)), true)
    assert.equal(tokenMatches(newAgentToken(), hashToken(token)), false)
  })

  test('a short or malformed stored hash does not throw', () => {
    assert.equal(tokenMatches(newAgentToken(), 'abcd'), false)
  })

  test('tokens are unique across many mints', () => {
    const seen = new Set(Array.from({ length: 500 }, () => newAgentToken()))
    assert.equal(seen.size, 500)
  })
})

describe('rbac ladder', () => {
  test('roles inherit downward', () => {
    assert.ok(atLeast('owner', 'viewer'))
    assert.ok(atLeast('admin', 'deployer'))
    assert.ok(!atLeast('deployer', 'admin'))
  })

  test('a deployer can deploy but cannot remove a node', () => {
    assert.ok(can('deployer', 'service.deploy'))
    assert.ok(!can('deployer', 'node.remove'))
    assert.ok(!can('deployer', 'member.manage'))
  })

  test('a viewer can only read', () => {
    assert.ok(can('viewer', 'logs.read'))
    assert.ok(!can('viewer', 'service.deploy'))
    assert.ok(!can('viewer', 'secret.write'))
  })

  test('only an owner manages billing and membership', () => {
    assert.ok(can('owner', 'billing.manage'))
    assert.ok(!can('admin', 'billing.manage'))
  })
})
