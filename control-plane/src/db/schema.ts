import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  pgEnum,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'

/* ── enums ─────────────────────────────────────────────────────────
   Kept as real Postgres enums rather than text + a check constraint:
   the scheduler reads these on every placement decision and an
   invalid value there is a correctness bug, not a validation nicety. */

export const orgRole = pgEnum('org_role', ['owner', 'admin', 'deployer', 'viewer'])
export const nodeStatus = pgEnum('node_status', ['online', 'offline', 'cordoned', 'draining'])
export const reliabilityTier = pgEnum('reliability_tier', ['opportunistic', 'standard', 'high'])
export const placementPolicy = pgEnum('placement_policy', ['pinned', 'preferred', 'flexible'])
export const reclaimPolicy = pgEnum('reclaim_policy', ['eager', 'idle', 'manual'])
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_key').on(t.email)]
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
    replicas: integer('replicas').notNull().default(1),

    healthCheckPath: text('health_check_path').default('/'),
    /** The port the container listens on inside itself. */
    containerPort: integer('container_port').notNull().default(8080),
    /** User-supplied hostname, e.g. web.yourdomain.dev. */
    domain: text('domain'),
    /** Always-present managed hostname, e.g. web.homelab.fleetos.app. */
    hostname: text('hostname'),
    reclaimPolicy: reclaimPolicy('reclaim_policy'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('services_fleet_name_key').on(t.fleetId, t.name),
    // Two services answering the same hostname is a routing coin-flip, so
    // the database refuses it rather than the proxy guessing.
    uniqueIndex('services_hostname_key').on(t.hostname),
    uniqueIndex('services_domain_key').on(t.domain),
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

export const secrets = pgTable(
  'secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    // envelope encrypted: {v, iv, tag, ciphertext, wrappedDek}
    encryptedValue: jsonb('encrypted_value').$type<Record<string, string>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('secrets_service_key_key').on(t.serviceId, t.key)]
)

export const backups = pgTable('backups', {
  id: uuid('id').primaryKey().defaultRandom(),
  serviceId: uuid('service_id')
    .notNull()
    .references(() => services.id, { onDelete: 'cascade' }),
  volumeRef: text('volume_ref').notNull(),
  storageLocation: text('storage_location').notNull(),
  sizeBytes: integer('size_bytes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  retentionExpiresAt: timestamp('retention_expires_at', { withTimezone: true }),
})

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
