/**
 * Recognising a connection string that names a managed database.
 *
 * `uses: [db]` gives a service DATABASE_URL and friends. An imported compose
 * file usually has its own variable for the same thing — MONGODB_URI,
 * DATABASE_URL, REDIS_URL — pointing at the compose service that just became a
 * managed database. Left alone that variable is either copied verbatim, so the
 * app dials a host that no longer exists, or moved to `secrets`, so the user is
 * asked to supply a value Fleet already knows. Both end in an app that deploys
 * and cannot reach its database.
 *
 * This is deliberately a copy of what the control plane computes, because the
 * CLI cannot import it — they are separate packages, and the CLI has to work
 * against a control plane it did not build. The copy is kept honest by a test
 * in the control plane that reads this file and fails when the two disagree,
 * which is the only thing that makes duplicating it acceptable.
 */

/** Does this value look like a connection URL aimed at `host`? */
export function pointsAt(value: string, host: string): boolean {
  // Scheme-relative on purpose: an app may hold a mongodb+srv:// or a
  // postgresql:// where Fleet writes postgres://, and the host is what says
  // this is the same database rather than an unrelated service.
  const match = value.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^:/?#]+)/i)
  return match?.[1]?.toLowerCase() === host.toLowerCase()
}
