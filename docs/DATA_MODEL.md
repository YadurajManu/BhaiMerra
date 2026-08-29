# Data model

Postgres stores durable identity, topology, desired configuration, and release
history. Redis stores only expiring liveness and progress data.

```mermaid
erDiagram
  USERS ||--o{ ORG_MEMBERS : belongs_to
  ORGS ||--o{ ORG_MEMBERS : has
  ORGS ||--o{ FLEETS : owns
  FLEETS ||--o{ NODES : contains
  FLEETS ||--o{ SERVICES : declares
  FLEETS ||--o{ PAIRING_TOKENS : issues
  FLEETS ||--o{ GITHUB_REPOSITORIES : connects
  SERVICES ||--o{ DEPLOYMENTS : releases
  NODES ||--o{ DEPLOYMENTS : runs
  SERVICES ||--o{ PLACEMENT_EVENTS : moves
  NODES ||--o{ PLACEMENT_EVENTS : destination
  USERS ||--o{ AUDIT_LOG : acts
  ORGS ||--o{ AUDIT_LOG : scopes
  SERVICES ||--o{ ALERT_RULES : watches

  USERS {
    uuid id PK
    text email UK
    text password_hash
    timestamp created_at
  }
  ORGS {
    uuid id PK
    text name
    enum plan
    timestamp created_at
  }
  ORG_MEMBERS {
    uuid org_id FK
    uuid user_id FK
    enum role
    timestamp created_at
  }
  FLEETS {
    uuid id PK
    uuid org_id FK
    text name
    enum default_reclaim_policy
    int heartbeat_interval_sec
    int heartbeat_miss_threshold
  }
  NODES {
    uuid id PK
    uuid fleet_id FK
    text name
    text arch
    text os
    int cpu_cores
    int ram_mb
    int disk_mb
    boolean has_gpu
    text reliability_tier
    text status
    text advertise_addr
    text agent_version
    timestamp last_heartbeat_at
  }
  SERVICES {
    uuid id PK
    uuid fleet_id FK
    text name
    text image
    text build_context
    text repo_url
    enum placement_policy
    uuid pinned_node_id FK
    int request_ram_mb
    int replicas
    text volume_name
    jsonb manifest
  }
  DEPLOYMENTS {
    uuid id PK
    uuid service_id FK
    uuid node_id FK
    enum status
    text git_sha
    text_array image_tags
    int host_port
    text failure_reason
    timestamp started_at
    timestamp finished_at
  }
  PLACEMENT_EVENTS {
    uuid id PK
    uuid service_id FK
    uuid from_node_id FK
    uuid to_node_id FK
    enum reason
    jsonb detail
    timestamp created_at
  }
  PAIRING_TOKENS {
    uuid id PK
    uuid fleet_id FK
    text token_hash
    timestamp expires_at
    timestamp consumed_at
    uuid consumed_by_node_id FK
  }
  GITHUB_REPOSITORIES {
    uuid id PK
    uuid fleet_id FK
    text repository
    text branch
    text manifest_path
    boolean enabled
  }
  ALERT_RULES {
    uuid id PK
    uuid service_id FK
    text event_types
    text channel
    boolean enabled
  }
  AUDIT_LOG {
    uuid id PK
    uuid org_id FK
    uuid actor_user_id FK
    text action
    text target_type
    uuid target_id
    jsonb metadata
    timestamp created_at
  }
```

## Relationships and lifecycle

- Deleting an organization cascades to its memberships, fleets, nodes, and
  services. Audit rows retain actor context where the schema permits it.
- A service has many deployments. A new rollout supersedes the previous live
  deployment; it does not delete it, so rollback and incident history remain
  auditable.
- Deployments reference nodes, but node removal is a revocation operation. The
  service history remains and a flexible service can be rescheduled elsewhere.
- Volumes are represented by service configuration and are intentionally not
  copied during failover. A volume-bearing service is therefore pinned to its
  storage node.
- Heartbeat payloads are not durable entities: Redis keys expire and the latest
  summary is copied into the node row. Logs are bounded agent snapshots, not a
  long-term log store.
