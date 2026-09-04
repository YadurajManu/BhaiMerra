import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { relations, sql } from 'drizzle-orm'

/* ── enums ─────────────────────────────────────────────────────────
   Kept as real Postgres enums rather than text + a check constraint:
   the scheduler reads these on every placement decision and an
   invalid value there is a correctness bug, not a validation nicety. */

export const orgRole = pgEnum('org_role', ['owner', 'admin', 'deployer', 'viewer'])
export const nodeStatus = pgEnum('node_status', ['online', 'offline', 'cordoned', 'draining'])
export const reliabilityTier = pgEnum('reliability_tier', ['opportunistic', 'standard', 'high'])
export const placementPolicy = pgEnum('placement_policy', ['pinned', 'preferred', 'flexible'])
export const reclaimPolicy = pgEnum('reclaim_policy', ['eager', 'idle', 'manual'])
export const backupStatus = pgEnum('backup_status', ['pending', 'running', 'complete', 'failed'])
export const restoreStatus = pgEnum('restore_status', ['pending', 'running', 'complete', 'failed'])

export const deploymentStatus = pgEnum('deployment_status', [
  'queued',
  'building',
  'pushing',
  'scheduling',
  'deploying',
  'running',
  'failed',
  // PRD 6.4: a pinned service on a downed node. Deliberately not 'failed' —
  // it did not crash, it is being held on purpose, and the dashboard has to
  // be able to say which.
  'pinned_unavailable',
  'rolled_back',
  'superseded',
])
export const placementReason = pgEnum('placement_reason', [
  'initial',
  'manual',
  'failover',
  'reclaim',
  'drain',
  'redeploy',
])
export const alertChannel = pgEnum('alert_channel', ['webhook', 'email', 'discord', 'slack', 'push'])
export const plan = pgEnum('plan', ['free', 'fleet', 'self_hosted'])

/* ── identity ──────────────────────────────────────────────────── */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    totpSecret: text('totp_secret'), // PRD 7.8 — optional 2FA
    /** Null until the address is confirmed. Accounts predating this are backfilled. */
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    /** When the owner asked. Kept separate so "requested but not confirmed" is visible. */
    deletionRequestedAt: timestamp('deletion_requested_at', { withTimezone: true }),
    /** Set once confirmed. Until this passes, the account works normally and can be reclaimed. */
    deletionScheduledFor: timestamp('deletion_scheduled_for', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_key').on(t.email)]
)

/**
 * Single-use, short-lived tokens for password reset and email verification.
 * Only the sha256 of the token is stored: the plaintext lives in the email and
 * nowhere else, so this table is not a set of working reset links.
 */
export const authTokens = pgTable(
  'auth_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    purpose: text('purpose').$type<'password_reset' | 'email_verify' | 'account_delete'>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('auth_tokens_hash_key').on(t.tokenHash)]
)

/**
 * One row per user per remembered device. Used to decide whether a sign-in is
 * new and therefore worth telling the account owner about.
 */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Browser family + OS family only. Versions change too often to be signal. */
    deviceHash: text('device_hash').notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    country: text('country'),
    firstSeen: timestamp('first_seen', { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp('last_seen', { withTimezone: true }).notNull().defaultNow(),
    loginCount: integer('login_count').notNull().default(1),
  },
  (t) => [uniqueIndex('auth_sessions_user_device_key').on(t.userId, t.deviceHash)]
)

export const orgs = pgTable('orgs', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  plan: plan('plan').notNull().default('free'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const orgMembers = pgTable(
  'org_members',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: orgRole('role').notNull().default('viewer'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('org_members_pk').on(t.orgId, t.userId),
    index('org_members_user_idx').on(t.userId),
  ]
)

/* ── fleet topology ────────────────────────────────────────────── */

export const fleets = pgTable(
  'fleets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    defaultReclaimPolicy: reclaimPolicy('default_reclaim_policy').notNull().default('idle'),
    // PRD 9 / open question 12: these are per-fleet because home networks
    // differ enough that one global default will be wrong for someone.
    heartbeatIntervalSec: integer('heartbeat_interval_sec').notNull().default(5),
    heartbeatMissThreshold: integer('heartbeat_miss_threshold').notNull().default(3),
    // Opt-in, per fleet: an agent may replace itself with the build the
    // control plane serves. Off by default, because on-by-default means one
    // bad build reaches every node everywhere at once.
    agentAutoUpgrade: boolean('agent_auto_upgrade').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('fleets_org_name_key').on(t.orgId, t.name)]
)

export const nodes = pgTable(
  'nodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fleetId: uuid('fleet_id')
      .notNull()
      .references(() => fleets.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),

    // capability, reported by the agent at registration (FR-2)
    arch: text('arch').notNull(),
    os: text('os').notNull().default('linux'),
    cpuCores: integer('cpu_cores').notNull(),
    ramMb: integer('ram_mb').notNull(),
    diskMb: integer('disk_mb').notNull(),
    hasGpu: boolean('has_gpu').notNull().default(false),
    connectivity: text('connectivity').notNull().default('nat'),

    reliabilityTier: reliabilityTier('reliability_tier').notNull().default('standard'),
    tags: text('tags').array().notNull().default([]),

    status: nodeStatus('status').notNull().default('offline'),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    meshPubkey: text('mesh_pubkey'),

    // Where the ingress proxy can actually reach this node. Until the mesh
    // lands (Phase 4b) this must be directly routable from the control plane;
    // afterwards it becomes the node's mesh address.
    advertiseAddr: text('advertise_addr'),

    // hashed, never stored in the clear (§10)
    agentTokenHash: text('agent_token_hash').notNull(),
    agentVersion: text('agent_version'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('nodes_fleet_name_key').on(t.fleetId, t.name),
    index('nodes_fleet_status_idx').on(t.fleetId, t.status),
  ]
)

/** Short-lived, single-use pairing tokens (§7 pairing flow step 1). */
export const pairingTokens = pgTable(
  'pairing_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fleetId: uuid('fleet_id')
      .notNull()
      .references(() => fleets.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    issuedByUserId: uuid('issued_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    consumedByNodeId: uuid('consumed_by_node_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('pairing_tokens_hash_key').on(t.tokenHash)]
)

/**
 * A repository deliberately connected to one fleet. This is distinct from a
 * service's repoUrl: it lets a first push create services from fleet.yaml,
 * and retains the selected GitHub account, branch and manifest location.
 */
/**
 * Which org owns which GitHub App installation.
 *
 * The App's installation list is global to the App, so without this every
 * signed-up user could reach every other account's private repositories. An
 * installation is claimed exactly once, by the org that completed the install
 * flow, and every GitHub lookup is filtered through the claims of the caller's
 * own org.
 */
export const githubInstallations = pgTable(
  'github_installations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    installationId: text('installation_id').notNull(),
    account: text('account').notNull(),
    accountType: text('account_type').notNull().default('User'),
    connectedByUserId: uuid('connected_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Set while GitHub has suspended the installation; cleared on unsuspend. */
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('github_installations_installation_key').on(t.installationId),
    index('github_installations_org_idx').on(t.orgId),
  ]
)

export const githubRepositories = pgTable(
  'github_repositories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fleetId: uuid('fleet_id')
      .notNull()
      .references(() => fleets.id, { onDelete: 'cascade' }),
    installationId: text('installation_id'),
    account: text('account').notNull(),
    fullName: text('full_name').notNull(),
    cloneUrl: text('clone_url').notNull(),
    defaultBranch: text('default_branch').notNull(),
    branch: text('branch').notNull(),
    manifestPath: text('manifest_path').notNull().default('fleet.yaml'),
    isPrivate: boolean('is_private').notNull().default(false),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('github_repositories_fleet_full_name_key').on(t.fleetId, t.fullName),
    index('github_repositories_fleet_idx').on(t.fleetId),
  ]
)

/* ── workloads ─────────────────────────────────────────────────── */

export const services = pgTable(
  'services',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fleetId: uuid('fleet_id')
      .notNull()
      .references(() => fleets.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /**
     * The manifest this service came from. A fleet.yaml describes a stack, and
     * without this the stack is lost the moment it is applied — four related
     * services become four unrelated rows next to somebody else's.
     *
     * Also what scopes the orphan warning: "no longer in fleet.yaml" is only
     * meaningful about the manifest being applied.
     */
    project: text('project').notNull().default('default'),

    repoUrl: text('repo_url'),
    buildContext: text('build_context'),
    image: text('image'), // set instead of buildContext for prebuilt images

    placementPolicy: placementPolicy('placement_policy').notNull().default('flexible'),
    pinnedNodeId: uuid('pinned_node_id').references(() => nodes.id, { onDelete: 'set null' }),

    // hard constraints consumed by the scheduler (§8 filter step)
    requestRamMb: integer('request_ram_mb').notNull().default(256),
    requestCpu: text('request_cpu').notNull().default('0.25'),
    requiresGpu: boolean('requires_gpu').notNull().default(false),
    minReliabilityTier: reliabilityTier('min_reliability_tier').notNull().default('opportunistic'),
    compatibleArches: text('compatible_arches').array().notNull().default([]),

    affinity: text('affinity').array().notNull().default([]),
    antiAffinity: text('anti_affinity').array().notNull().default([]),

    persistentVolume: boolean('persistent_volume').notNull().default(false),
    volumeName: text('volume_name'),
    /**
     * Where the volume is mounted inside the container. The image decides this
     * — Postgres wants /var/lib/postgresql/data — so a single hardcoded /data
     * mounted the volume somewhere the process never writes.
     */
    volumePath: text('volume_path'),
    replicas: integer('replicas').notNull().default(1),
    /**
     * How often to back this service's volume up unasked, e.g. "daily".
     * Null means never, which is what every service meant before backups
     * existed.
     */
    backupSchedule: text('backup_schedule'),

    healthCheckPath: text('health_check_path').default('/'),
    healthIntervalSec: integer('health_interval_sec').notNull().default(15),
    healthTimeoutSec: integer('health_timeout_sec').notNull().default(5),
    /** For images with no shell to probe with. */
    healthDisabled: boolean('health_disabled').notNull().default(false),
    /**
     * Plain configuration from the manifest's `env:` block. Not sensitive by
     * definition — anything that is belongs in `secrets` and is referenced by
     * name from `secretRefs`.
     */
    env: jsonb('env').$type<Record<string, string>>().notNull().default({}),
    /**
     * Secret names this service needs, from the manifest's `secrets:` list.
     * Only the names live here; the values are resolved from the secret store
     * at deploy time and never stored on the service row.
     */
    secretRefs: text('secret_refs').array().notNull().default([]),
    /** The port the container listens on inside itself. */
    containerPort: integer('container_port').notNull().default(8080),
    /** User-supplied hostname, e.g. web.yourdomain.dev. */
    domain: text('domain'),
    /**
     * Managed hostname, e.g. web-homelab-7efe4c.fleetos.app. Null for internal
     * services, which are deliberately not addressable from outside the node.
     */
    hostname: text('hostname'),
    /**
     * Reachable only by other services, by name, on the node's fleet network.
     * No published host port, no managed hostname, no ingress route — which is
     * what a database wants and what every service used to get anyway.
     */
    internal: boolean('internal').notNull().default(false),
    reclaimPolicy: reclaimPolicy('reclaim_policy'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('services_fleet_name_key').on(t.fleetId, t.name),
    // Two services answering the same hostname is a routing coin-flip, so
    // the database refuses it rather than the proxy guessing.
    uniqueIndex('services_hostname_key').on(t.hostname),
    uniqueIndex('services_domain_key').on(t.domain),
    index('services_fleet_project_idx').on(t.fleetId, t.project),
  ]
)

export const deployments = pgTable(
  'deployments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    gitSha: text('git_sha'),
    status: deploymentStatus('status').notNull().default('queued'),
    nodeId: uuid('node_id').references(() => nodes.id, { onDelete: 'set null' }),
    imageTags: text('image_tags').array().notNull().default([]),
    /** Host port the agent publishes this container on, so ingress can reach it. */
    hostPort: integer('host_port'),
    failureReason: text('failure_reason'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('deployments_service_idx').on(t.serviceId, t.startedAt),
    index('deployments_node_idx').on(t.nodeId),
    // The ingress proxy resolves a hostname to a live deployment on every
    // request; this is the index that keeps that a lookup rather than a scan.
    index('deployments_live_idx').on(t.status, t.nodeId),
  ]
)

export const placementEvents = pgTable(
  'placement_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    fromNodeId: uuid('from_node_id').references(() => nodes.id, { onDelete: 'set null' }),
    toNodeId: uuid('to_node_id').references(() => nodes.id, { onDelete: 'set null' }),
    reason: placementReason('reason').notNull(),
    // why the scheduler chose this node — surfaced verbatim in the timeline
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('placement_events_service_idx').on(t.serviceId, t.createdAt)]
)

/**
 * Telemetry history, downsampled.
 *
 * Heartbeats live in Redis under a TTL so a restart costs a detection cycle
 * rather than data. That makes every reading an instant with no before, which
 * is why nothing in the product could show a trend. This is the before.
 */
export const nodeSamples = pgTable(
  'node_samples',
  {
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull(),
    cpuPct: real('cpu_pct'),
    ramUsedMb: integer('ram_used_mb'),
    diskUsedMb: integer('disk_used_mb'),
    diskTotalMb: integer('disk_total_mb'),
    containers: integer('containers'),
    /**
     * Peaks, preserved through every roll-up. The mean alone answers "how busy
     * on average"; only the max answers "did it ever run out", which is the
     * question someone is actually asking.
     */
    cpuMax: real('cpu_max'),
    cpuMin: real('cpu_min'),
    ramMaxMb: integer('ram_max_mb'),
    /** A rate the agent computes by differencing byte counters, not a counter. */
    netRxKbps: integer('net_rx_kbps'),
    netTxKbps: integer('net_tx_kbps'),
    load1: real('load1'),
    tempC: real('temp_c'),
    swapUsedMb: integer('swap_used_mb'),
    dockerOk: boolean('docker_ok'),
    /** 'fine' (10s), 'minute', or 'hour'. Coarser grains outlive finer ones. */
    grain: text('grain').$type<'fine' | 'minute' | 'hour'>().notNull().default('fine'),
  },
  (t) => [
    primaryKey({ columns: [t.nodeId, t.at, t.grain] }),
    index('node_samples_node_at_idx').on(t.nodeId, t.grain, t.at),
  ]
)

/* ── operations ────────────────────────────────────────────────── */

export const alertRules = pgTable('alert_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  fleetId: uuid('fleet_id')
    .notNull()
    .references(() => fleets.id, { onDelete: 'cascade' }),
  channelType: alertChannel('channel_type').notNull(),
  channelConfig: jsonb('channel_config').$type<Record<string, unknown>>().notNull(),
  eventTypes: text('event_types').array().notNull().default([]),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** FR-15. Written synchronously with the mutating action, in the same
 *  transaction — see §10. Never best-effort. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorKind: text('actor_kind').notNull().default('user'), // user | agent | system
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_log_org_idx').on(t.orgId, t.createdAt)]
)

/**
 * The secret store (FR-13).
 *
 * Scoped to the fleet, not the service. A `web` + `postgres` stack needs the
 * same POSTGRES_PASSWORD in two places — the database to set it, the app to
 * connect with it — and per-service storage means entering it twice and
 * keeping the copies in sync by hand, which is how they drift apart.
 *
 * A row with a `serviceId` is an override for that one service. Resolution is
 * service first, then fleet, so a single service can be given a different
 * value without disturbing the rest.
 */
export const secrets = pgTable(
  'secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fleetId: uuid('fleet_id')
      .notNull()
      .references(() => fleets.id, { onDelete: 'cascade' }),
    /** null means fleet-wide; set means an override for this service only. */
    serviceId: uuid('service_id').references(() => services.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    // envelope encrypted: {v, iv, tag, ciphertext, dekIv, dekTag, wrappedDek}
    encryptedValue: jsonb('encrypted_value').$type<Record<string, string>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Partial uniques, because "one fleet-wide value per key" and "one override
    // per service and key" are two different rules. A plain unique on
    // (service_id, key) cannot express the first one, since every fleet-wide
    // row has service_id null and nulls do not collide.
    uniqueIndex('secrets_fleet_key_key')
      .on(t.fleetId, t.key)
      .where(sql`service_id is null`),
    uniqueIndex('secrets_service_key_key')
      .on(t.serviceId, t.key)
      .where(sql`service_id is not null`),
    index('secrets_fleet_idx').on(t.fleetId),
  ]
)

/**
 * A copy of a volume, taken by the node that holds it.
 *
 * A job before it is an artifact: the row exists from the moment a backup is
 * asked for, the node performs it on its next poll, and the archive arrives
 * afterwards. Attempts that failed stay here, because "the last three backups
 * failed" is the half people actually need when they come looking — which the
 * original shape, describing only a finished file, had nowhere to put.
 */
export const backups = pgTable(
  'backups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    /** Kept when the node goes: a backup from a machine that no longer exists
     *  is exactly when its origin matters. */
    nodeId: uuid('node_id').references(() => nodes.id, { onDelete: 'set null' }),
    volumeRef: text('volume_ref').notNull(),
    status: backupStatus('status').notNull().default('pending'),
    /** Relative to the control plane's backup root; null until it lands. */
    storageLocation: text('storage_location'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    /** sha256, so a restore can prove it got what was stored. */
    checksum: text('checksum'),
    failureReason: text('failure_reason'),
    scheduled: boolean('scheduled').notNull().default(false),
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    retentionExpiresAt: timestamp('retention_expires_at', { withTimezone: true }),
  },
  (t) => [
    index('backups_service_idx').on(t.serviceId, t.createdAt),
    index('backups_pending_idx').on(t.nodeId, t.status),
  ]
)

/* ── relations ─────────────────────────────────────────────────── */

export const orgRelations = relations(orgs, ({ many }) => ({
  members: many(orgMembers),
  fleets: many(fleets),
}))

export const fleetRelations = relations(fleets, ({ one, many }) => ({
  org: one(orgs, { fields: [fleets.orgId], references: [orgs.id] }),
  nodes: many(nodes),
  services: many(services),
}))

export const nodeRelations = relations(nodes, ({ one }) => ({
  fleet: one(fleets, { fields: [nodes.fleetId], references: [fleets.id] }),
}))

export const serviceRelations = relations(services, ({ one, many }) => ({
  fleet: one(fleets, { fields: [services.fleetId], references: [fleets.id] }),
  deployments: many(deployments),
}))

/**
 * Putting a backup back.
 *
 * Its own job rather than a field on the backup, because the same archive can
 * legitimately be restored more than once — onto a rebuilt node, into a fresh
 * volume, twice in an afternoon while something is being debugged. Recorded on
 * the backup row it would keep only the last attempt and lose exactly the
 * history that matters when a restore goes wrong.
 */
export const restores = pgTable(
  'restores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    backupId: uuid('backup_id')
      .notNull()
      .references(() => backups.id, { onDelete: 'cascade' }),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    /** Not necessarily the node the backup came from — restoring onto a
     *  replacement machine is the case this exists for. */
    nodeId: uuid('node_id').references(() => nodes.id, { onDelete: 'set null' }),
    volumeName: text('volume_name').notNull(),
    status: restoreStatus('status').notNull().default('pending'),
    failureReason: text('failure_reason'),
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('restores_service_idx').on(t.serviceId, t.createdAt),
    index('restores_pending_idx').on(t.nodeId, t.status),
  ]
)

/**
 * Cached explanations, keyed by failure signature.
 *
 * Shared across fleets on purpose: a missing base image is the same problem
 * for everybody, and the log it was derived from is not kept here.
 */
export const deploymentExplanations = pgTable('deployment_explanations', {
  signature: text('signature').primaryKey(),
  summary: text('summary').notNull(),
  steps: jsonb('steps').$type<string[]>().notNull().default([]),
  model: text('model').notNull(),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  hits: integer('hits').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
