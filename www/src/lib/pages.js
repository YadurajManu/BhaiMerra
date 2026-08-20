// Every sub-page on the site. Content lives here; PageShell renders it.
// Block types: h | p | list | code | kv | table | note | links | terms

const P = (text) => ({ t: 'p', text })
const H = (text) => ({ t: 'h', text })
const L = (items) => ({ t: 'list', items })

export const PAGES = {
  /* ─────────────────────────── Developers ─────────────────────────── */
  docs: {
    group: 'Developers',
    title: 'Documentation',
    kicker: 'start here',
    lede: 'Everything needed to take a machine you own from unplugged to serving traffic. Fifteen minutes for the first node, less for every node after it.',
    updated: '20 Aug 2026',
    blocks: [
      H('Install the agent'),
      P('The install script detects the architecture, downloads the matching static binary, installs a systemd unit and registers the node against a pairing token you generate from the dashboard. Pairing tokens are single-use and expire after ten minutes.'),
      { t: 'code', lang: 'sh', lines: [
        '$ curl -fsSL fleet-os.dev/install | sh -s -- --token fl_9c2a4e1b',
        '  → detected linux/arm64 · 4 cores · 8192 MB · 119 GB free',
        '  → installed /usr/local/bin/fleet-agent (11.4 MB)',
        '  → systemd unit fleet-agent.service enabled',
        '  ✓ registered as node-02 in fleet "homelab"',
      ]},
      { t: 'note', tone: 'signal', text: 'The agent needs access to the local Docker socket and outbound HTTPS. It never needs an inbound port, and it never opens one.' },

      H('Describe the fleet'),
      P('One fleet.yaml at the root of your repository declares services, their placement policy and their resource requests. The full grammar is in the fleet.yaml spec; this is the shape of it.'),
      { t: 'code', lang: 'yaml', lines: [
        'fleet: homelab',
        '',
        'services:',
        '  web:',
        '    build: ./apps/web',
        '    placement: flexible          # scheduler picks the node',
        '    resources: { ram: 512Mi, cpu: 0.5 }',
        '    health: { path: /healthz, timeout: 5s }',
        '    domain: web.yourdomain.dev',
        '',
        '  postgres:',
        '    image: postgres:16',
        '    placement: pinned            # never moves on its own',
        '    node: node-03',
        '    volume: pgdata',
      ]},

      H('Push'),
      P('Add the fleet remote and push. The control plane builds a multi-arch image with Buildx, pushes it to your registry, asks the scheduler where each service should run, and instructs those agents to converge. Health checks gate the cutover; a failing check rolls back to the previous deployment on the same node.'),
      { t: 'code', lang: 'sh', lines: [
        '$ git remote add fleet git@fleet-os.dev:you/homelab.git',
        '$ git push fleet main',
      ]},

      H('Where to go next'),
      { t: 'links', items: [
        ['fleet.yaml spec', '#/docs/fleet-yaml', 'Every field, every default, every valid value.'],
        ['Constraint-based scheduler', '#/docs/scheduler', 'How placement is filtered, ranked and overridden.'],
        ['Mesh networking', '#/docs/mesh', 'WireGuard peers, ingress, TLS, service discovery.'],
        ['Failover and reclaim', '#/docs/failover', 'What happens when a node stops answering.'],
        ['CLI reference', '#/docs/cli', 'Every command and flag.'],
        ['REST API', '#/docs/api', 'The same surface the dashboard uses.'],
        ['Self-hosting guide', '#/docs/self-hosting', 'Run the control plane on your own metal.'],
      ]},
    ],
  },

  'docs/fleet-yaml': {
    group: 'Developers',
    title: 'fleet.yaml spec',
    kicker: 'reference',
    lede: 'The single declarative file that describes a fleet. Committed to your repository, versioned with your code, applied on push.',
    updated: '14 Aug 2026',
    blocks: [
      H('Top level'),
      { t: 'kv', rows: [
        ['fleet', 'string · required. The fleet this repository deploys into.'],
        ['services', 'map · required. Service name → service definition.'],
        ['defaults', 'map · optional. Values merged into every service.'],
      ]},

      H('Service definition'),
      { t: 'table', head: ['Field', 'Type', 'Default', 'Notes'], rows: [
        ['build', 'path', '—', 'Build context. Mutually exclusive with image.'],
        ['image', 'ref', '—', 'Pre-built image. Skips the build step.'],
        ['placement', 'enum', 'flexible', 'flexible | preferred | pinned'],
        ['node', 'node id', '—', 'Required when placement is pinned or preferred.'],
        ['resources.ram', 'quantity', '256Mi', 'Hard constraint during filtering.'],
        ['resources.cpu', 'float', '0.25', 'Used for ranking, not enforced as a hard cap.'],
        ['arch', 'list', 'auto', 'Restrict to specific architectures.'],
        ['min_reliability', 'enum', 'any', 'any | intermittent | always-on'],
        ['gpu', 'bool', 'false', 'Filters to nodes reporting a GPU.'],
        ['volume', 'name', '—', 'Named persistent volume. Implies node affinity.'],
        ['domain', 'hostname', '—', 'Public ingress. TLS issued automatically.'],
        ['health.path', 'path', '/', 'Checked before a deployment is promoted.'],
        ['env', 'map', '{}', 'Plain values. Use secrets for anything sensitive.'],
        ['secrets', 'list', '[]', 'Names resolved from the fleet secret store.'],
        ['replicas', 'int', '1', 'Spread across distinct nodes where possible.'],
        ['affinity', 'list', '[]', 'Service names to co-locate with.'],
        ['anti_affinity', 'list', '[]', 'Service names to keep apart.'],
        ['reclaim', 'enum', 'idle', 'eager | idle | never'],
      ]},

      H('Placement policies'),
      L([
        'flexible — the scheduler may place and re-place this service on any eligible node. The default, and correct for anything stateless.',
        'preferred — starts on the named node, may be moved on failure, returns when the node is healthy again if reclaim allows.',
        'pinned — runs only on the named node. On failure it raises a distinct pinned-service alert and stays down until the node returns.',
      ]),
      { t: 'note', tone: 'warn', text: 'A service with a volume is treated as pinned to the node holding that volume, whatever placement says. Declaring it explicitly is clearer for whoever reads the file next.' },

      H('Reclaim behaviour'),
      { t: 'kv', rows: [
        ['eager', 'Move back to the original node as soon as it is healthy. Causes a second restart.'],
        ['idle', 'Move back at the next deploy, not before. The default; no surprise restarts.'],
        ['never', 'Stay where it landed. The original node becomes just another candidate.'],
      ]},

      H('A complete example'),
      { t: 'code', lang: 'yaml', lines: [
        'fleet: homelab',
        '',
        'defaults:',
        '  reclaim: idle',
        '  health: { path: /healthz, timeout: 5s, interval: 15s }',
        '',
        'services:',
        '  web:',
        '    build: ./apps/web',
        '    placement: flexible',
        '    resources: { ram: 512Mi, cpu: 0.5 }',
        '    domain: web.yourdomain.dev',
        '    anti_affinity: [img-proxy]',
        '',
        '  img-proxy:',
        '    build: ./apps/imgproxy',
        '    placement: flexible',
        '    min_reliability: intermittent',
        '    resources: { ram: 768Mi, cpu: 1.0 }',
        '',
        '  postgres:',
        '    image: postgres:16',
        '    placement: pinned',
        '    node: node-03',
        '    volume: pgdata',
        '    secrets: [POSTGRES_PASSWORD]',
        '',
        '  whisper:',
        '    build: ./apps/whisper',
        '    gpu: true',
        '    arch: [amd64]',
        '    resources: { ram: 4Gi }',
      ]},
    ],
  },

  'docs/cli': {
    group: 'Developers',
    title: 'CLI reference',
    kicker: 'reference',
    lede: 'The fleet binary talks to the same REST API the dashboard does. Anything you can click, you can script.',
    updated: '18 Aug 2026',
    blocks: [
      H('Install'),
      { t: 'code', lang: 'sh', lines: [
        '$ brew install fleet-os/tap/fleet     # macOS',
        '$ curl -fsSL fleet-os.dev/cli | sh    # linux',
        '$ fleet auth login',
      ]},

      H('Fleet and nodes'),
      { t: 'table', head: ['Command', 'What it does'], rows: [
        ['fleet init', 'Scaffold a fleet.yaml from the repository contents.'],
        ['fleet nodes', 'List nodes with arch, load, service count and status.'],
        ['fleet nodes pair', 'Mint a single-use pairing token for a new machine.'],
        ['fleet nodes cordon <node>', 'Stop scheduling new work onto a node.'],
        ['fleet nodes drain <node>', 'Move every flexible service off a node, then cordon it.'],
        ['fleet nodes rm <node>', 'Revoke credentials and remove the node from the fleet.'],
      ]},

      H('Services and deploys'),
      { t: 'table', head: ['Command', 'What it does'], rows: [
        ['fleet deploy [--sha]', 'Trigger a deploy at HEAD or an explicit commit.'],
        ['fleet status', 'One-screen view of the whole fleet.'],
        ['fleet logs <svc> -f', 'Follow logs across whichever node holds the service.'],
        ['fleet rollback <svc>', 'Return to the previous deployment.'],
        ['fleet reschedule <svc>', 'Force a placement decision to be recomputed.'],
        ['fleet secrets set K=V', 'Write an envelope-encrypted secret.'],
        ['fleet events --since 1h', 'Unified event timeline, newest last.'],
      ]},

      H('Output'),
      P('Every command accepts --json. The shape matches the REST response for the equivalent endpoint, so a script written against the CLI ports to the API without rewriting the parsing.'),
      { t: 'code', lang: 'sh', lines: [
        '$ fleet nodes --json | jq -r \'.[] | select(.status=="online") | .name\'',
        'node-01',
        'node-02',
        'node-04',
      ]},

      H('Exit codes'),
      { t: 'kv', rows: [
        ['0', 'Success.'],
        ['1', 'Generic failure — message on stderr.'],
        ['2', 'Invalid usage or malformed fleet.yaml.'],
        ['3', 'No eligible node for one or more services.'],
        ['4', 'Deploy rolled back after a failed health check.'],
      ]},
    ],
  },

  'docs/api': {
    group: 'Developers',
    title: 'REST API',
    kicker: 'reference',
    lede: 'A JSON API over HTTPS. Bearer tokens for users, mTLS or signed tokens for agents. Every mutating endpoint is RBAC-checked and written to the audit log synchronously.',
    updated: '18 Aug 2026',
    blocks: [
      H('Authentication'),
      { t: 'code', lang: 'sh', lines: [
        '$ curl https://api.fleet-os.dev/v1/fleets/homelab/nodes \\',
        '    -H "Authorization: Bearer $FLEET_TOKEN"',
      ]},
      P('Tokens are scoped to an organisation and carry a role. Refresh tokens rotate on use; a reused refresh token invalidates the whole chain.'),

      H('Fleets and nodes'),
      { t: 'table', head: ['Method', 'Path', 'Role'], rows: [
        ['GET', '/v1/fleets/:id', 'viewer'],
        ['GET', '/v1/fleets/:id/nodes', 'viewer'],
        ['POST', '/v1/fleets/:id/nodes/pair-token', 'admin'],
        ['POST', '/v1/nodes/:id/cordon', 'admin'],
        ['POST', '/v1/nodes/:id/drain', 'admin'],
        ['DELETE', '/v1/nodes/:id', 'owner'],
      ]},

      H('Services and deployments'),
      { t: 'table', head: ['Method', 'Path', 'Role'], rows: [
        ['POST', '/v1/fleets/:id/services', 'deployer'],
        ['POST', '/v1/services/:id/deploy', 'deployer'],
        ['GET', '/v1/services/:id/deployments', 'viewer'],
        ['POST', '/v1/deployments/:id/rollback', 'deployer'],
        ['GET', '/v1/services/:id/logs', 'viewer'],
        ['POST', '/v1/services/:id/reschedule', 'deployer'],
        ['GET', '/v1/fleets/:id/placement-map', 'viewer'],
        ['GET', '/v1/fleets/:id/events', 'viewer'],
        ['POST', '/v1/fleets/:id/alert-rules', 'admin'],
      ]},

      H('Example response'),
      { t: 'code', lang: 'json', lines: [
        '{',
        '  "id": "node-01",',
        '  "name": "home-server",',
        '  "arch": "amd64",',
        '  "cpu_cores": 4,',
        '  "ram_mb": 8192,',
        '  "has_gpu": false,',
        '  "reliability_tier": "always-on",',
        '  "status": "online",',
        '  "last_heartbeat_at": "2026-08-20T14:02:06.418Z",',
        '  "services": ["web", "cache", "img-proxy"]',
        '}',
      ]},

      H('Rate limits and errors'),
      L([
        '600 requests per minute per token. Burst of 60. Limits are returned in X-RateLimit-* headers.',
        'Errors use a stable machine-readable code plus a human message: { "code": "no_eligible_node", "message": "…" }.',
        'Webhooks are signed with an HMAC over the raw body; verify before trusting the payload.',
      ]),
    ],
  },

  'docs/scheduler': {
    group: 'Product',
    title: 'Constraint-based scheduler',
    kicker: 'concept',
    lede: 'Placement is a filter followed by a ranking. It is intentionally simple enough to predict by hand, because you will need to predict it by hand at 2am.',
    updated: '11 Aug 2026',
    blocks: [
      H('Filtering: hard constraints'),
      P('A node is eligible only if every one of these holds. Nothing is a preference at this stage.'),
      L([
        'Architecture is in the service\'s compatible set.',
        'Node status is online — not offline, not cordoned.',
        'Free RAM is at or above the service\'s request.',
        'A GPU is present if the service declares gpu: true.',
        'Reliability tier is at or above min_reliability.',
        'Affinity and anti-affinity rules are satisfied.',
      ]),

      H('Ranking: a weighted score'),
      P('Eligible nodes are scored and the highest wins. The weights favour leaving headroom over packing tightly, because a homelab node that hits swap takes its neighbours down with it.'),
      { t: 'kv', rows: [
        ['free RAM ratio', 'Weight 0.5 — spread rather than pack.'],
        ['reliability tier', 'Weight 0.3 — prefer the box that stays on.'],
        ['current load', 'Weight 0.2 — avoid the node already working.'],
      ]},
      { t: 'code', lang: 'text', lines: [
        'eligible = nodes.filter(n =>',
        '  n.arch in service.compatible_arches',
        '  and n.status == "online"',
        '  and n.free_ram >= service.resources.ram',
        '  and (not service.gpu or n.has_gpu)',
        '  and n.reliability_tier >= service.min_reliability',
        ')',
        '',
        'ranked = eligible.sort_by(n =>',
        '  0.5 * n.free_ram_ratio',
        '+ 0.3 * n.reliability_score',
        '+ 0.2 * (1 - n.current_load)',
        ')',
        '',
        'return ranked.first()',
      ]},

      H('When nothing is eligible'),
      P('The deploy fails loudly with exit code 3 and an explanation per node — which constraint each one failed. It does not silently place the service somewhere that cannot run it, and it does not wait indefinitely for capacity that may never arrive.'),

      H('Overriding it'),
      P('fleet reschedule forces a recomputation. Pinning a service removes it from scheduling entirely. Cordoning a node removes that node from every future eligible set without touching what is already running on it.'),
    ],
  },

  'docs/mesh': {
    group: 'Product',
    title: 'Mesh networking and ingress',
    kicker: 'concept',
    lede: 'Every node is a WireGuard peer in a mesh scoped to its own fleet. Public traffic enters at one edge and is proxied over the mesh to whichever node currently holds the service.',
    updated: '09 Aug 2026',
    blocks: [
      H('The mesh'),
      L([
        'One mesh per fleet. Fleets never share a mesh, and orgs never share keys.',
        'The control plane holds the coordination and key-distribution role only. It is not in the data path between two nodes.',
        'Peers behind NAT connect outbound; there is no port to forward and no dynamic DNS script to babysit.',
        'Node credentials rotate on a schedule and can be revoked individually from the dashboard if a device is lost.',
      ]),

      H('Service discovery'),
      P('Services resolve each other by name inside the mesh. The name follows the workload, so a service that was rescheduled onto a different node is still reachable at the same address by everything that depends on it.'),
      { t: 'code', lang: 'sh', lines: [
        '# from inside any container in the fleet',
        '$ curl http://postgres.homelab.internal:5432',
        '$ curl http://img-proxy.homelab.internal:8080/resize',
      ]},

      H('Public ingress'),
      { t: 'kv', rows: [
        ['Managed subdomain', 'yourservice.fleetos.app — TLS on a control-plane wildcard certificate. Nothing to configure.'],
        ['Your own domain', 'A Cloudflare Tunnel is provisioned and bound for you. Certificates are issued and renewed over ACME.'],
      ]},
      { t: 'note', tone: 'warn', text: 'Tunnels default to HTTP/2 rather than QUIC. QUIC is faster where it works, and unreliable on networks that treat long-lived UDP as suspicious — which describes a lot of home ISPs. You can opt into QUIC per tunnel.' },

      H('What is not encrypted twice'),
      P('Traffic between nodes is encrypted by WireGuard. Agent-to-control-plane requests are additionally authenticated with mTLS or a signed token, because relying on the mesh alone means one compromised key is a total compromise.'),
    ],
  },

  'docs/failover': {
    group: 'Product',
    title: 'Failover and reclaim',
    kicker: 'concept',
    lede: 'A node going quiet is an ordinary event, not an incident. What happens next depends entirely on whether the service on it was flexible or pinned.',
    updated: '16 Aug 2026',
    blocks: [
      H('Detection'),
      P('Agents heartbeat every five seconds by default, carrying resource usage, container states and mesh status. The control plane writes each heartbeat to Redis with a TTL slightly longer than the interval; a background job watches for expiry. No node is polled, so detection cost does not grow with fleet size.'),
      { t: 'kv', rows: [
        ['HEARTBEAT_INTERVAL_SEC', '5 by default, overridable per fleet.'],
        ['HEARTBEAT_MISS_THRESHOLD', '3 consecutive misses before a node is marked down.'],
        ['Typical detection', '15 seconds. Typical reschedule-to-serving, ~4 seconds after that.'],
      ]},

      H('Flexible services'),
      P('Removed from the dead node\'s inventory, re-filtered and re-ranked against the remaining nodes, then started on the winner. The event timeline records why that node was chosen and what its score was.'),

      H('Pinned services'),
      P('Deliberately not moved. Moving a database away from its volume is worse than the outage. Instead a pinned-service alert fires on its own channel, naming the service, the node and the reason it stayed put — so it is never confused with a routine reschedule.'),
      { t: 'note', tone: 'signal', text: 'This distinction is the whole point. A tool that silently relocates your Postgres has not saved you anything.' },

      H('When the node comes back'),
      { t: 'kv', rows: [
        ['reclaim: eager', 'Services return immediately. Costs a second restart.'],
        ['reclaim: idle', 'Services return at the next deploy. The default.'],
        ['reclaim: never', 'Services stay where they landed.'],
      ]},

      H('Drift detection'),
      P('If a node comes back running a container the control plane did not schedule — a leftover from a manual docker run, or a stale workload from before it went dark — that is reported as drift rather than quietly reconciled away, and you decide what happens to it.'),
    ],
  },

  'docs/self-hosting': {
    group: 'Developers',
    title: 'Self-hosting guide',
    kicker: 'open core',
    lede: 'Run the coordination layer on your own metal. Same codebase as the hosted product, with the paid gates compiled out.',
    updated: '12 Aug 2026',
    blocks: [
      H('What you need'),
      L([
        'PostgreSQL 15 or newer — the source of truth for fleets, nodes, services and the audit log.',
        'Redis 7 or newer — heartbeat liveness, pub/sub, and the build queue.',
        'An OCI registry the agents can pull from. A self-hosted registry is fine.',
        'A host with a public name and a certificate. Nginx and Certbot are the documented path.',
      ]),

      H('Docker Compose'),
      { t: 'code', lang: 'sh', lines: [
        '$ git clone https://github.com/fleet-os/fleet-os',
        '$ cd fleet-os/deploy/compose',
        '$ cp .env.example .env    # then edit',
        '$ docker compose up -d',
      ]},

      H('Environment'),
      { t: 'kv', rows: [
        ['DATABASE_URL', 'Postgres connection string.'],
        ['REDIS_URL', 'Redis connection string.'],
        ['JWT_SECRET', 'Auth token signing key.'],
        ['MESH_COORDINATOR_KEY', 'Mesh coordination service credential.'],
        ['REGISTRY_URL', 'Container registry endpoint.'],
        ['REGISTRY_CREDENTIALS', 'Push and pull auth for that registry.'],
        ['SECRETS_MASTER_KEY', 'Envelope-encryption master key. Back this up separately.'],
        ['CLOUDFLARE_API_TOKEN', 'Optional. Only needed for tunnel automation.'],
        ['HEARTBEAT_INTERVAL_SEC', 'Default heartbeat interval. Fleet-overridable.'],
        ['HEARTBEAT_MISS_THRESHOLD', 'Missed heartbeats before a node is marked down.'],
      ]},
      { t: 'note', tone: 'warn', text: 'Lose SECRETS_MASTER_KEY and every stored secret is unrecoverable. It is not derivable from the database and it is not stored in it.' },

      H('What differs from hosted'),
      L([
        'No billing gates — every feature is available.',
        'No managed *.fleetos.app subdomain. Bring your own domain and certificate.',
        'Control-plane HA is your responsibility; the single-node install is a single point of coordination.',
        'Backups of Postgres and the secret master key are yours to run and to test.',
      ]),

      H('Upgrades'),
      P('Migrations run on boot and are forward-only. Take a database snapshot first. Agents one minor version behind the control plane keep working; two behind will refuse to register and tell you so.'),
    ],
  },

  /* ─────────────────────────── Company ─────────────────────────── */
  changelog: {
    group: 'Product',
    title: 'Changelog',
    kicker: 'releases',
    lede: 'What shipped, when, and what broke. Dates are release dates, not merge dates.',
    updated: '20 Aug 2026',
    blocks: [
      H('v0.9.2 — 18 August 2026'),
      L([
        'Pinned-service alerts now route to their own channel, separate from reschedule notifications.',
        'Scheduler explains rejections per node on a failed placement instead of returning a single error.',
        'Agent memory footprint down from 58 MB to 41 MB resident on arm64.',
        'Fixed: drain could return before the last container had actually stopped.',
      ]),
      H('v0.9.0 — 29 July 2026'),
      L([
        'Reclaim policies: eager, idle and never, settable per service and per fleet.',
        'Drift detection reports unmanaged containers rather than removing them.',
        'Cloudflare Tunnel binding defaults to HTTP/2; QUIC is now opt-in per tunnel.',
        'Breaking: reclaim_on_return was replaced by reclaim. The old key warns for one more minor version.',
      ]),
      H('v0.8.4 — 2 July 2026'),
      L([
        'armv7 builds are no longer experimental.',
        'Event timeline gained filtering by service, node and event type.',
        'Fixed: a node returning within the heartbeat window could be marked down anyway.',
      ]),
      H('v0.8.0 — 10 June 2026'),
      L([
        'Constraint-based scheduler replaces round-robin placement.',
        'Multi-arch builds via Buildx on the control-plane runner.',
        'RBAC with four roles, and a synchronously written audit log.',
      ]),
    ],
  },

  about: {
    group: 'Company',
    title: 'About',
    kicker: 'who this is',
    lede: 'Fleet OS started as a pile of Raspberry Pis, one always-on mini PC, and a docker-compose file that nobody wanted to touch.',
    updated: '01 Aug 2026',
    blocks: [
      H('Why it exists'),
      P('The tooling gap is specific. Managed platforms are excellent and charge rent for compute that is already sitting in your cupboard. Self-hosted platforms are free and assume the box never goes away. Kubernetes handles all of it and costs more attention than a personal fleet is worth. None of them are wrong; none of them fit two Pis, a laptop and a five-dollar VPS.'),

      H('What we believe'),
      L([
        'Hardware you already own should be a first-class deploy target, not a hobby project.',
        'A device disappearing is normal behaviour, not an exception to be handled later.',
        'A tool that silently moves a database has not helped you.',
        'The coordination layer should be self-hostable by anyone whose objection to the cloud is the cloud.',
      ]),

      H('How we are funded'),
      P('Subscription revenue from the Fleet tier. No advertising, no data resale, and no free tier that exists to harvest anything. The free single-node tier is a complete product because a fleet of one is a legitimate place to start.'),

      H('Talk to us'),
      { t: 'links', items: [
        ['Contact', '#/contact', 'Support, security reports, press, everything else.'],
        ['Roadmap', '#/roadmap', 'What is being built, in what order.'],
        ['Community', '#/community', 'Where the conversation actually happens.'],
      ]},
    ],
  },

  blog: {
    group: 'Company',
    title: 'Writing',
    kicker: 'blog',
    lede: 'Notes from building a scheduler for hardware that keeps unplugging itself.',
    updated: '15 Aug 2026',
    blocks: [
      H('Why we do not move your database'),
      P('15 August 2026 · 9 min. Automatic failover for stateful services sounds like the feature and is actually the trap. A walk through what happens when a volume and its workload disagree about which machine they live on, and why a loud alert beats a clever migration.'),

      H('Detecting a dead node without polling it'),
      P('02 August 2026 · 6 min. Heartbeats into Redis with a TTL, a sweeper for expired keys, and why the naive version — asking every node every tick — stops being viable at exactly the scale where it starts to matter.'),

      H('Multi-arch builds are a scheduling problem'),
      P('21 July 2026 · 7 min. Building for arm64, armv7 and amd64 is the easy half. Knowing which of those a given service is allowed to land on, and refusing to guess, is the half that determines whether the fleet works.'),

      H('The QUIC tunnel that worked everywhere except home'),
      P('04 July 2026 · 5 min. A debugging story about UDP, consumer routers, and why the tunnel defaults changed to HTTP/2 in v0.9.0.'),
    ],
  },

  roadmap: {
    group: 'Company',
    title: 'Roadmap',
    kicker: 'what is next',
    lede: 'Ordered by what unblocks the most people, not by what demos best. Dates are intentions, not commitments.',
    updated: '19 Aug 2026',
    blocks: [
      H('Shipping now'),
      L([
        'Persistent volume snapshots with retention policies.',
        'Preview environments — one ephemeral placement per pull request.',
        'Alert routing rules by service and severity, not just by fleet.',
      ]),
      H('Next'),
      L([
        'Offloading builds to the most capable node in the fleet, for fully disconnected operation.',
        'Multi-dimensional bin-packing in the scheduler, tuned against real placement data.',
        'Companion mobile app with push notifications for pinned-service alerts.',
      ]),
      H('Being decided'),
      L([
        'Embedded tsnet versus a bespoke WireGuard coordination server. Highest-leverage open decision.',
        'Go versus Rust for the agent binary beyond v1.',
        'Where the open-core line sits — which control-plane modules ship source-available.',
      ]),
      { t: 'note', tone: 'signal', text: 'Roadmap items get reordered by what people actually ask for. The community channels are where that happens.' },
    ],
  },

  security: {
    group: 'Company',
    title: 'Security',
    kicker: 'posture',
    lede: 'How credentials, secrets and access are handled, and how to report something we got wrong.',
    updated: '10 Aug 2026',
    blocks: [
      H('Reporting a vulnerability'),
      P('Send details to security@fleet-os.dev. We acknowledge within one business day and aim to have a fix or a mitigation within fourteen days for anything exploitable. We will not pursue legal action against good-faith research that avoids privacy violations, data destruction and service degradation.'),

      H('Credentials'),
      L([
        'Pairing tokens are single-use and expire in ten minutes.',
        'Per-node agent credentials rotate on a schedule and are individually revocable — a lost laptop is a one-click problem.',
        'Agent-to-control-plane requests use mTLS or a signed token in addition to mesh encryption.',
        'User refresh tokens rotate on use; replaying one invalidates the chain.',
      ]),

      H('Secrets'),
      P('Secrets are envelope-encrypted at rest in Postgres under a control-plane master key, backed by a KMS in the hosted product. They are decrypted in memory on the target agent at container start and are never written to disk on the node.'),

      H('Access and audit'),
      L([
        'RBAC is enforced at the API layer for every mutating endpoint, not only in the dashboard.',
        'Four roles: owner, admin, deployer, viewer.',
        'The audit log is written synchronously with the mutating action, so it can be relied on for review rather than treated as best-effort telemetry.',
      ]),

      H('What we do not do'),
      L([
        'We do not have access to the contents of your containers or your volumes.',
        'We do not proxy service-to-service traffic through our infrastructure; the mesh is peer to peer.',
        'We do not sell, share or train on your data. See the privacy notice.',
      ]),
    ],
  },

  status: {
    group: 'Company',
    title: 'Status',
    kicker: 'operational',
    lede: 'Current state of the hosted control plane. Self-hosted installs are unaffected by anything on this page.',
    updated: 'live',
    blocks: [
      { t: 'status', rows: [
        ['Control plane API', 'operational', '99.98% · 90d'],
        ['Mesh coordinator', 'operational', '99.99% · 90d'],
        ['Build runners', 'operational', '99.94% · 90d'],
        ['Container registry', 'operational', '99.97% · 90d'],
        ['Dashboard', 'operational', '99.99% · 90d'],
        ['Managed ingress (*.fleetos.app)', 'operational', '99.96% · 90d'],
      ]},
      H('Recent incidents'),
      L([
        '02 August 2026 — Build runners queued for 22 minutes during a registry credential rotation. No deploys were lost; all queued builds completed. Resolved in 41 minutes.',
        '17 July 2026 — Elevated heartbeat latency in eu-central caused false down-markings for 9 nodes across 4 fleets. Flexible services were rescheduled and reclaimed automatically. Threshold logic was adjusted in v0.8.4.',
      ]),
      { t: 'note', tone: 'signal', text: 'A node in your own fleet going offline is not an incident here — check the fleet event timeline in your dashboard.' },
    ],
  },

  contact: {
    group: 'Company',
    title: 'Contact',
    kicker: 'get in touch',
    lede: 'Four addresses, all of them read by a person.',
    updated: '01 Aug 2026',
    blocks: [
      { t: 'kv', rows: [
        ['support@fleet-os.dev', 'Anything broken, confusing or missing. Include your fleet name and a rough timestamp.'],
        ['security@fleet-os.dev', 'Vulnerability reports. See the security page for the disclosure process.'],
        ['hello@fleet-os.dev', 'Partnerships, press, and questions that do not fit anywhere else.'],
        ['privacy@fleet-os.dev', 'Data access, correction and deletion requests.'],
      ]},
      H('Before you write in'),
      L([
        'A failed deploy usually explains itself — fleet events --since 1h is the fastest first look.',
        '"No eligible node" means a hard constraint failed; the scheduler names which one per node.',
        'A pinned service that is down will stay down by design until its node returns.',
      ]),
      H('Response times'),
      P('Free tier: best effort, usually two to three business days. Fleet tier: one business day. Security reports are acknowledged within one business day regardless of tier.'),
    ],
  },

  community: {
    group: 'Community',
    title: 'Community',
    kicker: 'where people are',
    lede: 'Most of the useful conversation about running a small mixed fleet happens outside our docs. Here is where.',
    updated: '20 Aug 2026',
    blocks: [
      { t: 'links', items: [
        ['Discord', 'https://discord.gg/fleet-os', 'Day-to-day help, #placement-help and #show-your-fleet. Fastest route to an answer.'],
        ['GitHub', 'https://github.com/fleet-os/fleet-os', 'Agent, CLI and the source-available control plane. Issues and discussions live here.'],
        ['r/selfhosted', 'https://reddit.com/r/selfhosted', 'The broader self-hosting community. Not ours, and better for it.'],
        ['Homelab showcase', '#/community', 'Fleet layouts people have posted — what they run, on what, and why.'],
        ['Support forum', '#/contact', 'Longer-form troubleshooting threads that outlive a chat scroll.'],
        ['Bluesky', 'https://bsky.app/profile/fleet-os.dev', 'Release notes and the occasional debugging story.'],
      ]},
      H('House rules'),
      L([
        'Post the fleet.yaml and the event timeline. Nobody can debug placement from a description.',
        'Redact domains and secrets, keep node names — they are the useful half.',
        '"Why did it pick that node?" is always a good question and always has a concrete answer.',
      ]),
      H('Contributing'),
      P('The agent, the CLI and the source-available parts of the control plane take pull requests. Start with an issue describing the behaviour you want; placement and failover changes need a test with synthetic node fixtures before they can be reviewed.'),
    ],
  },

  github: {
    group: 'Developers',
    title: 'Source',
    kicker: 'github',
    lede: 'The agent, the CLI, and the source-available portion of the control plane.',
    updated: '20 Aug 2026',
    blocks: [
      { t: 'links', items: [
        ['fleet-os/fleet-os', 'https://github.com/fleet-os/fleet-os', 'Monorepo: control plane, agent, dashboard, CLI.'],
        ['fleet-os/agent', 'https://github.com/fleet-os/fleet-os', 'Go agent. Static binaries for arm64, armv7 and amd64.'],
        ['fleet-os/cli', 'https://github.com/fleet-os/fleet-os', 'The fleet command.'],
        ['fleet-os/examples', 'https://github.com/fleet-os/fleet-os', 'Worked fleet.yaml files for common homelab setups.'],
      ]},
      H('Repository layout'),
      { t: 'code', lang: 'text', lines: [
        'fleet-os/',
        '  control-plane/   fastify api, scheduler, heartbeat, alerting, mesh',
        '  agent/           go binary — capability, docker, heartbeat, mesh',
        '  dashboard/       react spa',
        '  cli/             the fleet command',
        '  docs/            fleet.yaml spec, self-hosting, api reference',
      ]},
      H('Licence'),
      P('The agent, CLI and dashboard are MIT. The control plane is source-available under the Fleet OS Community Licence — free for self-hosting, including commercially, with the single restriction that it may not be offered as a competing managed service. Full text on the licence page.'),
    ],
  },

  /* ─────────────────────────── Legal ─────────────────────────── */
  'legal/privacy': {
    group: 'Legal',
    title: 'Privacy notice',
    kicker: 'your data',
    lede: 'What we collect, why, how long we keep it, and how to make us delete it. Written to be read rather than skimmed past.',
    updated: '01 August 2026',
    blocks: [
      H('What we collect'),
      { t: 'kv', rows: [
        ['Account data', 'Email address and a password hash. Organisation name and member roles.'],
        ['Fleet metadata', 'Node names, architecture, core count, RAM, disk, GPU presence, reliability tier, online status.'],
        ['Operational telemetry', 'Heartbeats, resource usage, container states, placement decisions and deployment outcomes.'],
        ['Logs', 'Container stdout and stderr you send to us, retained per your plan.'],
        ['Billing data', 'Handled by our payment processor. We store a customer reference and a plan, never card details.'],
      ]},

      H('What we do not collect'),
      L([
        'The contents of your volumes or the data inside your containers.',
        'Service-to-service traffic. The mesh is peer to peer; it does not pass through us.',
        'Your source code, beyond the build context needed to produce the image you asked for.',
        'Behavioural advertising identifiers. There are no third-party ad or analytics trackers on this site.',
      ]),

      H('Why we process it'),
      P('To operate the service you asked for: scheduling workloads, detecting failures, issuing certificates, sending the alerts you configured, and billing the plan you chose. Aggregate, non-identifying placement statistics inform scheduler tuning. That is the complete list of purposes.'),

      H('Retention'),
      { t: 'kv', rows: [
        ['Heartbeat records', '7 days.'],
        ['Event timeline', '30 days on the free tier, 12 months on Fleet.'],
        ['Container logs', '3 days on the free tier, 30 days on Fleet.'],
        ['Audit log', '12 months, or longer where a legal obligation requires it.'],
        ['Account data', 'Until you delete the account, then 30 days in backups.'],
      ]},

      H('Sharing'),
      P('We use a small number of processors — cloud hosting, a payment processor, a transactional email provider and an error-reporting service — each bound by a data processing agreement and each used only for the purpose named. We do not sell personal data, we do not share it for advertising, and we do not use customer data to train models.'),

      H('Your rights'),
      L([
        'Access — request a copy of the personal data we hold about you.',
        'Correction — have inaccurate data fixed.',
        'Deletion — have your account and its data removed.',
        'Portability — export your fleet configuration and event history as JSON at any time from the dashboard.',
        'Objection — object to processing that relies on legitimate interests.',
      ]),
      P('Write to privacy@fleet-os.dev. We respond within thirty days, and usually much sooner. If you are unhappy with the response you may complain to your local data protection authority.'),

      H('Cookies'),
      P('One first-party session cookie, required to keep you signed in. One preference cookie for your theme. No analytics cookies, no third-party cookies, and therefore no consent banner to dismiss.'),

      H('Self-hosting'),
      { t: 'note', tone: 'signal', text: 'If you run the control plane yourself, none of the above applies to your fleet data — it never reaches us. This notice then covers only your account on this website, if you have one.' },

      H('Changes'),
      P('Material changes are announced by email to account holders at least thirty days before they take effect, and the revision date at the top of this page is updated. Previous versions are kept in the public repository.'),
    ],
  },

  'legal/terms': {
    group: 'Legal',
    title: 'Terms of service',
    kicker: 'the agreement',
    lede: 'The agreement between you and Fleet OS for the hosted product. Plain terms, no surprises buried in a subclause.',
    updated: '01 August 2026',
    blocks: [
      H('1. The agreement'),
      P('By creating an account you accept these terms. If you are accepting on behalf of an organisation, you confirm you are authorised to bind it. If you do not accept, do not create an account — the self-hosted control plane is available under a separate licence and does not require this agreement.'),

      H('2. The service'),
      P('Fleet OS coordinates deployments onto compute you own or rent. We provide the control plane, the scheduler, the mesh coordination service, the build runners and the dashboard. We do not provide the compute, and we are not responsible for the availability of hardware you operate.'),

      H('3. Your responsibilities'),
      L([
        'Keep your credentials secure and revoke access for devices you no longer control.',
        'Hold the rights necessary to deploy and run whatever you deploy.',
        'Do not use the service to distribute malware, run denial-of-service infrastructure, mine cryptocurrency on other people\'s hardware, or host material that is illegal where you or we operate.',
        'Do not attempt to circumvent plan limits, probe the isolation between organisations, or resell the hosted service as your own.',
      ]),

      H('4. Plans, billing and cancellation'),
      L([
        'The free tier is free indefinitely and limited to a single node.',
        'Paid plans bill monthly in advance. Prices are per organisation, not per node.',
        'You may cancel at any time; service continues to the end of the paid period and does not renew.',
        'We may change prices with thirty days\' notice. Existing subscriptions keep their price to the end of the current period.',
        'Refunds are issued where we have failed to provide the service, and pro rata where we have materially reduced it.',
      ]),

      H('5. Your data'),
      P('Your fleet configuration, logs and event history remain yours. We process them only to run the service, as described in the privacy notice. You can export them at any time. On cancellation we retain them for thirty days so you can change your mind, then delete them.'),

      H('6. Availability'),
      P('We target 99.9% monthly availability for the hosted control plane and publish status at status.fleet-os.dev. Planned maintenance is announced in advance. A control-plane outage does not stop already-running containers on your nodes — agents keep them running and reconcile when connectivity returns.'),

      H('7. Suspension'),
      P('We may suspend an account for non-payment after notice, or immediately where continued operation would be unlawful or would endanger the service for others. We will tell you why, and restore access once the cause is resolved.'),

      H('8. Warranties and liability'),
      P('The service is provided as-is. We do not warrant that it will be uninterrupted or error-free. To the extent permitted by law, our aggregate liability under this agreement is limited to the fees you paid in the twelve months before the claim. Nothing here limits liability for death, personal injury, fraud, or anything else that cannot lawfully be limited.'),

      H('9. Changes and termination'),
      P('We may update these terms with thirty days\' notice by email. Continuing to use the service after that means you accept the update. Either party may terminate for material breach that is not remedied within thirty days of written notice.'),

      H('10. Governing law'),
      P('These terms are governed by the laws of England and Wales, and the courts of England and Wales have exclusive jurisdiction, without affecting any mandatory consumer protections in your country of residence.'),

      { t: 'note', tone: 'warn', text: 'This is a marketing site for a product concept. Treat the text above as an illustrative template, not as legal advice or an executed agreement.' },
    ],
  },

  'legal/licence': {
    group: 'Legal',
    title: 'Licence',
    kicker: 'open core',
    lede: 'Two licences. Permissive for the parts that run on your machines, source-available with one restriction for the coordination layer.',
    updated: '01 August 2026',
    blocks: [
      H('MIT — agent, CLI, dashboard'),
      P('The agent binary, the fleet CLI and the dashboard are MIT licensed. Use them, fork them, ship them inside something commercial. Keep the copyright notice, and accept that they come without warranty.'),

      H('Fleet OS Community Licence — control plane'),
      P('The control plane is source-available. You may read it, modify it, and run it for any purpose including commercially, in your own organisation, for as many fleets and nodes as you like, at no cost.'),
      L([
        'You may run it internally without limit.',
        'You may modify it and run your modified version.',
        'You may redistribute it, with this licence attached.',
        'You may not offer it to third parties as a hosted or managed service that substitutes for the Fleet OS hosted product.',
      ]),
      { t: 'note', tone: 'signal', text: 'The single restriction exists so the hosted product can fund the open one. If you are self-hosting for your own fleet — which is most people reading this — it does not apply to you.' },

      H('Contributions'),
      P('Contributions are accepted under the licence of the component you are contributing to. There is no copyright assignment and no CLA; you keep ownership of what you write.'),

      H('Third-party components'),
      { t: 'kv', rows: [
        ['WireGuard', 'GPL-2.0 / MIT depending on the implementation used.'],
        ['Docker Buildx', 'Apache-2.0.'],
        ['PostgreSQL', 'PostgreSQL Licence.'],
        ['Redis', 'RSALv2 / SSPLv1 for versions 7.4 and later.'],
      ]},
      P('A complete dependency manifest with licences ships in the repository and is regenerated on every release.'),

      H('Trademarks'),
      P('The Fleet OS name and mark are not covered by either licence. You may say your project works with Fleet OS. You may not name a fork in a way that suggests it is the official distribution.'),
    ],
  },
}

// Order used for prev/next navigation at the foot of each page.
export const PAGE_ORDER = [
  'docs', 'docs/fleet-yaml', 'docs/scheduler', 'docs/mesh', 'docs/failover',
  'docs/cli', 'docs/api', 'docs/self-hosting', 'github', 'changelog',
  'roadmap', 'about', 'blog', 'security', 'status', 'contact', 'community',
  'legal/privacy', 'legal/terms', 'legal/licence',
]
