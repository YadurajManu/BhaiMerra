/**
 * Managed databases.
 *
 * Declaring Postgres by hand means getting six things right at once: the image
 * and tag, a volume with the engine's own data directory, PGDATA pointed at a
 * subdirectory because Postgres refuses to initialise into a mount that has a
 * lost+found in it, `internal: true` so the port is not published on the
 * node's LAN interface, a pin to the node holding the volume, and two secrets
 * whose values must match exactly or the app is refused at its first query.
 *
 * Every one of those is the same every time, and every one of them has a
 * failure that only shows up minutes later somewhere else. So the manifest
 * takes the two facts that actually differ — which engine, and which node
 * holds the data — and derives the rest.
 */

/** What a service needs to know to connect, and how to spell it. */
export type EngineSpec = {
  /** Image repository; the tag comes from the version the manifest asked for. */
  image: string
  defaultVersion: string
  port: number
  /** Where the engine keeps its data inside the container. */
  dataPath: string
  /** URL scheme for the composed connection string. */
  scheme: string
  defaultUser: string
  /** Env the database container itself needs, given a database and user. */
  serverEnv: (opts: { database: string; user: string; passwordRef: string }) => Record<string, string>
  /**
   * Whether this engine authenticates at all. Redis as shipped does not, and
   * inventing a password it will not enforce is worse than saying so.
   */
  usesPassword: boolean
  /** Whether a database name is meaningful for this engine. */
  usesDatabase: boolean
}

/**
 * The engines Fleet manages.
 *
 * Alpine variants throughout: these are pulled over whatever link a node
 * happens to have, and the difference between the alpine and debian images is
 * most of the download.
 */
export const ENGINES: Record<string, EngineSpec> = {
  postgres: {
    image: 'postgres',
    defaultVersion: '16-alpine',
    port: 5432,
    dataPath: '/var/lib/postgresql/data',
    scheme: 'postgres',
    defaultUser: 'postgres',
    usesPassword: true,
    usesDatabase: true,
    serverEnv: ({ database, user, passwordRef }) => ({
      POSTGRES_DB: database,
      POSTGRES_USER: user,
      POSTGRES_PASSWORD: `\${secret:${passwordRef}}`,
      // Postgres will not initialise into a directory that is not empty, and a
      // freshly mounted volume has a lost+found. Its own subdirectory is the
      // documented way around it, and forgetting this is a first-boot failure
      // that reads as a corrupt image.
      PGDATA: '/var/lib/postgresql/data/pgdata',
    }),
  },
  mysql: {
    image: 'mysql',
    defaultVersion: '8',
    port: 3306,
    dataPath: '/var/lib/mysql',
    scheme: 'mysql',
    defaultUser: 'app',
    usesPassword: true,
    usesDatabase: true,
    serverEnv: ({ database, user, passwordRef }) => ({
      MYSQL_DATABASE: database,
      MYSQL_USER: user,
      MYSQL_PASSWORD: `\${secret:${passwordRef}}`,
      // The root password is required for the image to start at all; reusing
      // the same secret keeps one credential per database rather than two.
      MYSQL_ROOT_PASSWORD: `\${secret:${passwordRef}}`,
    }),
  },
  mariadb: {
    image: 'mariadb',
    defaultVersion: '11',
    port: 3306,
    dataPath: '/var/lib/mysql',
    scheme: 'mysql',
    defaultUser: 'app',
    usesPassword: true,
    usesDatabase: true,
    serverEnv: ({ database, user, passwordRef }) => ({
      MARIADB_DATABASE: database,
      MARIADB_USER: user,
      MARIADB_PASSWORD: `\${secret:${passwordRef}}`,
      MARIADB_ROOT_PASSWORD: `\${secret:${passwordRef}}`,
    }),
  },
  redis: {
    image: 'redis',
    defaultVersion: '7-alpine',
    port: 6379,
    dataPath: '/data',
    scheme: 'redis',
    defaultUser: '',
    // The stock image starts with no auth. Generating a password and putting
    // it in a URL the server will not check is a lie about the security of
    // the thing, so it is left off and the service stays internal.
    usesPassword: false,
    usesDatabase: false,
    serverEnv: () => ({}),
  },
  mongo: {
    image: 'mongo',
    defaultVersion: '7',
    port: 27017,
    dataPath: '/data/db',
    scheme: 'mongodb',
    defaultUser: 'app',
    usesPassword: true,
    usesDatabase: true,
    serverEnv: ({ database, user, passwordRef }) => ({
      MONGO_INITDB_DATABASE: database,
      MONGO_INITDB_ROOT_USERNAME: user,
      MONGO_INITDB_ROOT_PASSWORD: `\${secret:${passwordRef}}`,
    }),
  },
}

export type DatabaseDecl = {
  name: string
  engine: string
  version: string
  node: string
  database: string
  user: string
  ramMb?: number
  cpu?: number
  /** How often to back its volume up: hourly, daily, weekly. */
  backup?: string
}

/** `postgres@16` → engine and tag. A bare name takes the engine's default. */
export function splitEngine(value: string): { engine: string; version: string | null } {
  const at = value.indexOf('@')
  if (at < 0) return { engine: value.trim().toLowerCase(), version: null }
  return {
    engine: value.slice(0, at).trim().toLowerCase(),
    version: value.slice(at + 1).trim() || null,
  }
}

/**
 * The secret holding this database's password.
 *
 * Derived from the name so it is predictable — `fleet secrets ls` shows
 * MAIN_PASSWORD for a database called `main`, and a person can replace it
 * without consulting anything.
 */
export function passwordRefFor(name: string): string {
  return `${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_PASSWORD`
}

/** The volume holding its data. Scoped by project so two clients never collide. */
export function volumeNameFor(project: string, name: string): string {
  return `${project}-${name}-data`
}

/**
 * The connection string a dependent service receives.
 *
 * The password is a `${secret:...}` reference rather than a literal: this
 * string is stored in the service's plain env, which is readable by anyone who
 * can read the manifest or the API. It is resolved into a real value only in
 * the desired state sent to the agent that runs the container.
 */
export function connectionUrl(db: DatabaseDecl, spec: EngineSpec): string {
  const auth = spec.usesPassword
    ? `${encodeURIComponent(db.user)}:\${secret:${passwordRefFor(db.name)}}@`
    : ''
  const path = spec.usesDatabase ? `/${db.database}` : ''
  // The host is the database's service name: containers resolve each other by
  // name on the node's fleet network.
  return `${spec.scheme}://${auth}${db.name}:${spec.port}${path}`
}

/**
 * The env a service gets for depending on a database.
 *
 * Both spellings, because applications disagree: a single URL is what most
 * modern libraries want, and the discrete parts are what a lot of older
 * configuration expects. Emitting both costs nothing and saves the user
 * writing the one their framework happens to need.
 */
export function clientEnv(db: DatabaseDecl, spec: EngineSpec, prefix: string): Record<string, string> {
  const env: Record<string, string> = {
    [`${prefix}_URL`]: connectionUrl(db, spec),
    [`${prefix}_HOST`]: db.name,
    [`${prefix}_PORT`]: String(spec.port),
  }
  if (spec.usesDatabase) env[`${prefix}_NAME`] = db.database
  if (spec.usesPassword) {
    env[`${prefix}_USER`] = db.user
    env[`${prefix}_PASSWORD`] = `\${secret:${passwordRefFor(db.name)}}`
  }
  return env
}

/**
 * The env-variable prefix a database contributes under.
 *
 * The first database in a manifest is almost always "the database", so it gets
 * the unprefixed DATABASE_* names every framework already looks for. Any
 * others are named after themselves, because there is no longer an obvious
 * default and guessing one would silently shadow the first.
 */
export function prefixFor(name: string, isPrimary: boolean): string {
  if (isPrimary) return 'DATABASE'
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
}

/**
 * Turn a database declaration into the service that runs it.
 *
 * The result is an ordinary service in every respect — it schedules, deploys,
 * reports health and appears in the dashboard like anything else. Nothing
 * downstream needs to know it was generated.
 */
export function expandDatabase(
  db: DatabaseDecl,
  project: string
): Record<string, unknown> {
  const spec = ENGINES[db.engine]!
  return {
    image: `${spec.image}:${db.version}`,
    // Never published on the node's interface. A database reachable from the
    // whole LAN because a port was bound is the single worst default here.
    internal: true,
    placement: 'pinned',
    node: db.node,
    volume: { name: volumeNameFor(project, db.name), path: spec.dataPath },
    container_port: spec.port,
    resources: {
      ram: db.ramMb ? `${db.ramMb}Mi` : '512Mi',
      cpu: db.cpu ?? 0.5,
    },
    env: spec.serverEnv({
      database: db.database,
      user: db.user,
      passwordRef: passwordRefFor(db.name),
    }),
    secrets: spec.usesPassword ? [passwordRefFor(db.name)] : [],
    // The health prober speaks HTTP and a database does not. Its readiness
    // shows up as the services that depend on it becoming healthy.
    health: { disabled: true },
    ...(db.backup ? { backup: db.backup } : {}),
  }
}
