import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Pairing and agent tokens are high-entropy random strings. We store only a
 * SHA-256 of them — there is no need for a slow KDF here the way there is for
 * user passwords, because these are 256-bit random values, not guessable
 * secrets. What matters is that a database dump never yields a usable token.
 */

const PAIRING_PREFIX = 'flp_'
const AGENT_PREFIX = 'fla_'

function mint(prefix: string): string {
  return prefix + randomBytes(32).toString('base64url')
}

export const newPairingToken = () => mint(PAIRING_PREFIX)
export const newAgentToken = () => mint(AGENT_PREFIX)

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Constant-time compare so a token hash cannot be recovered by timing. */
export function tokenMatches(token: string, storedHash: string): boolean {
  const a = Buffer.from(hashToken(token), 'hex')
  const b = Buffer.from(storedHash, 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export const isPairingToken = (t: string) => t.startsWith(PAIRING_PREFIX)
export const isAgentToken = (t: string) => t.startsWith(AGENT_PREFIX)
