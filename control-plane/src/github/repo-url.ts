/**
 * Repository identity.
 *
 * A repository arrives written a dozen ways — with and without the scheme,
 * with `.git`, over SSH, as `owner/name` — and every one of them has to match
 * the one form somebody happened to type into a manifest.
 */

/** Repos are written many ways; compare them on the part that identifies them. */
export function normaliseRepo(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^git\+/, '')
    .replace(/^https?:\/\//, '')
    .replace(/^git@/, '')
    .replace(/:/g, '/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
}

/**
 * Every spelling of the repository in a webhook payload, normalised.
 *
 * All four are offered because a service may have been configured with any of
 * them, and a push that fails to match its own repository is invisible.
 */
export function repoCandidates(repository: {
  full_name?: string
  clone_url?: string
  ssh_url?: string
  html_url?: string
}): string[] {
  return [repository.clone_url, repository.ssh_url, repository.html_url, repository.full_name]
    .filter((value): value is string => Boolean(value))
    .map(normaliseRepo)
}

/**
 * The project name a repository deploys into.
 *
 * Named after the repository because that is the grouping a person already has
 * in their head for these services.
 */
export function projectForRepo(repo: string): string | undefined {
  return (
    normaliseRepo(repo)
      .split('/')
      .pop()
      ?.replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || undefined
  )
}
