import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto'

/**
 * Envelope encryption for service secrets (PRD FR-13, tech doc §10).
 *
 * Each secret gets its own random data encryption key (DEK). The DEK is
 * wrapped with the control plane's master key and stored alongside the
 * ciphertext. Rotating the master key therefore means rewrapping DEKs rather
 * than re-encrypting every secret, and in the hosted product the master key
 * can move behind a KMS without changing this shape.
 */

export type SealedSecret = {
  v: string
  iv: string
  tag: string
  ciphertext: string
  dekIv: string
  dekTag: string
  wrappedDek: string
}

const VERSION = '1'
const ALG = 'aes-256-gcm'

function masterKey(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64')
  if (key.length !== 32) {
    throw new Error('SECRETS_MASTER_KEY must decode to exactly 32 bytes')
  }
  return key
}

function encrypt(key: Buffer, plaintext: Buffer) {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALG, key, iv)
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { iv, tag: cipher.getAuthTag(), ct }
}

function decrypt(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer) {
  const decipher = createDecipheriv(ALG, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
}

export function sealSecret(value: string, masterKeyB64: string): SealedSecret {
  const mk = masterKey(masterKeyB64)
  const dek = randomBytes(32)

  const body = encrypt(dek, Buffer.from(value, 'utf8'))
  const wrapped = encrypt(mk, dek)
  dek.fill(0)

  return {
    v: VERSION,
    iv: body.iv.toString('base64'),
    tag: body.tag.toString('base64'),
    ciphertext: body.ct.toString('base64'),
    dekIv: wrapped.iv.toString('base64'),
    dekTag: wrapped.tag.toString('base64'),
    wrappedDek: wrapped.ct.toString('base64'),
  }
}

export function openSecret(sealed: SealedSecret, masterKeyB64: string): string {
  if (sealed.v !== VERSION) {
    throw new Error(`Unsupported secret envelope version: ${sealed.v}`)
  }
  const mk = masterKey(masterKeyB64)

  const dek = decrypt(
    mk,
    Buffer.from(sealed.dekIv, 'base64'),
    Buffer.from(sealed.dekTag, 'base64'),
    Buffer.from(sealed.wrappedDek, 'base64')
  )

  try {
    return decrypt(
      dek,
      Buffer.from(sealed.iv, 'base64'),
      Buffer.from(sealed.tag, 'base64'),
      Buffer.from(sealed.ciphertext, 'base64')
    ).toString('utf8')
  } finally {
    dek.fill(0)
  }
}
