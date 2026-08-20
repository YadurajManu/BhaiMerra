import { hash, verify, argon2id, type HashOptions } from 'argon2'

/**
 * Argon2id with parameters chosen to be meaningful on the modest hardware a
 * self-hosted control plane is likely to run on — logging in should not cost
 * a visible pause on a small box.
 */
const OPTS: HashOptions = {
  type: argon2id,
  memoryCost: 19456, // 19 MiB — OWASP minimum for argon2id
  timeCost: 2,
  parallelism: 1,
}

export const hashPassword = (plain: string) => hash(plain, OPTS)

export async function verifyPassword(digest: string, plain: string): Promise<boolean> {
  try {
    return await verify(digest, plain, OPTS)
  } catch {
    // A malformed digest is a failed login, not a 500.
    return false
  }
}
