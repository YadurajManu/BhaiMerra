/**
 * What to call a managed database, when the obvious name breaks.
 *
 * The manifest derives a database's password secret from its name:
 * `passwordRefFor("main")` is MAIN_PASSWORD. That is a good rule, and it has
 * one collision. A database called `postgres` derives POSTGRES_PASSWORD, which
 * is also the environment variable the Postgres image itself expects — so the
 * generated service ends up with the same key in both `env` and `secrets`, and
 * the parser rejects the whole manifest.
 *
 * It matters because `postgres:` is one of the most common service names in a
 * docker-compose file, so the most ordinary input produced something the
 * product refused. Renaming to `db` is also simply what a person writing this
 * by hand would have done: `uses: [db, cache]` reads better than
 * `uses: [postgres, redis]`.
 */

/** What a person would call each engine, rather than what the image is called. */
const FRIENDLY: Record<string, string> = {
  postgres: 'db',
  mysql: 'db',
  mariadb: 'db',
  mongo: 'db',
  redis: 'cache',
}

export function safeDatabaseName(preferred: string, engine: string, taken: Set<string>): string {
  const base =
    preferred.toLowerCase() === engine.toLowerCase() ? (FRIENDLY[engine] ?? 'db') : preferred

  // Two Postgres databases in one file both want to be `db`.
  let name = base
  let n = 2
  while (taken.has(name)) name = `${base}${n++}`
  taken.add(name)
  return name
}
