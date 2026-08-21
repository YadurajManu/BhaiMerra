import { createSign, createPrivateKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'

/**
 * GitHub App authentication.
 *
 * A GitHub App, not an OAuth App, on purpose: an App gets per-installation
 * tokens that expire in an hour and are scoped to the repositories the user
 * actually granted. An OAuth App gets one long-lived token covering everything
 * that user can see, which is far too much for a service that clones code.
 */

export type GitHubConfig = {
  appId: string
  privateKeyPath: string
  clientId?: string
}

export class GitHubError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
  }
}

let cachedKey: string | null = null

async function privateKey(path: string): Promise<string> {
  if (cachedKey) return cachedKey
  try {
    cachedKey = await readFile(path, 'utf8')
  } catch {
    throw new GitHubError(
      `Could not read the GitHub App private key at "${path}". ` +
        `Download it from the app's settings page and point GITHUB_APP_PRIVATE_KEY_PATH at it.`
    )
  }
  return cachedKey
}

const b64url = (input: string | Buffer) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/**
 * A short-lived RS256 JWT proving we are the app. GitHub rejects anything
 * longer than ten minutes, and clock skew rejects anything issued in the
 * future — hence backdating `iat` by a minute.
 */
export async function appJwt(config: GitHubConfig): Promise<string> {
  const key = await privateKey(config.privateKeyPath)
  const now = Math.floor(Date.now() / 1000)

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: config.appId }))
  const signingInput = `${header}.${payload}`

  const signer = createSign('RSA-SHA256')
  signer.update(signingInput)
  signer.end()

  let signature: Buffer
  try {
    signature = signer.sign(createPrivateKey(key))
  } catch (err) {
    throw new GitHubError(`The GitHub App private key could not be used to sign: ${(err as Error).message}`)
  }
  return `${signingInput}.${b64url(signature)}`
}

async function ghFetch<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'fleet-os',
      ...(init.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(15_000),
  })
  const text = await res.text()
  const body = text ? JSON.parse(text) : null

  if (!res.ok) {
    const message = (body as { message?: string })?.message ?? `GitHub returned ${res.status}`
    throw new GitHubError(message, res.status)
  }
  return body as T
}

export type Installation = { id: number; account: { login: string; type: string } }

export async function listInstallations(config: GitHubConfig): Promise<Installation[]> {
  return ghFetch('https://api.github.com/app/installations', await appJwt(config))
}

type TokenResponse = { token: string; expires_at: string }

const tokenCache = new Map<number, TokenResponse>()

/**
 * Exchange the app JWT for an installation token.
 *
 * Cached until shortly before expiry: a fleet deploying several services from
 * one repo would otherwise mint a token per service, and GitHub rate-limits
 * that endpoint separately from the API itself.
 */
export async function installationToken(config: GitHubConfig, installationId: number): Promise<string> {
  const cached = tokenCache.get(installationId)
  if (cached && new Date(cached.expires_at).getTime() - Date.now() > 60_000) {
    return cached.token
  }

  const fresh = await ghFetch<TokenResponse>(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    await appJwt(config),
    { method: 'POST' }
  )
  tokenCache.set(installationId, fresh)
  return fresh.token
}

export type Repo = {
  full_name: string
  clone_url: string
  private: boolean
  default_branch: string
  updated_at: string
}

export async function listRepos(config: GitHubConfig, installationId: number): Promise<Repo[]> {
  const token = await installationToken(config, installationId)
  const { repositories } = await ghFetch<{ repositories: Repo[] }>(
    'https://api.github.com/installation/repositories?per_page=100',
    token
  )
  return repositories
}

/**
 * A clone URL carrying a short-lived installation token.
 *
 * The token is embedded in the URL because that is the only way `git fetch`
 * accepts credentials non-interactively. It expires within the hour, and the
 * URL is never logged or stored — see the redaction in checkoutRepo.
 */
export async function authenticatedCloneUrl(
  config: GitHubConfig,
  installationId: number,
  cloneUrl: string
): Promise<string> {
  const token = await installationToken(config, installationId)
  return cloneUrl.replace('https://', `https://x-access-token:${token}@`)
}

/** Find which installation can reach a repository, if any. */
export async function installationForRepo(
  config: GitHubConfig,
  repoFullName: string
): Promise<number | null> {
  for (const installation of await listInstallations(config)) {
    const repos = await listRepos(config, installation.id)
    if (repos.some((r) => r.full_name.toLowerCase() === repoFullName.toLowerCase())) {
      return installation.id
    }
  }
  return null
}
