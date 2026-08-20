// Every string on this page comes from here so the copy stays auditable.

export const STEPS = [
  {
    n: '01',
    kicker: 'register',
    title: 'Point the agent at a machine you own',
    body: 'One install line per device. A Pi, a laptop with the lid closed, a mini PC in a closet, a $5 VPS. The agent detects architecture, cores, RAM, disk and GPU, then reports in.',
    code: 'curl -fsSL fleet-os.dev/install | sh -s -- --token fl_9c2a…',
  },
  {
    n: '02',
    kicker: 'build',
    title: 'git push, and get a multi-arch image',
    body: 'The control plane builds with Buildx and pushes arm64, armv7 and amd64 tags to your registry. Mismatched hardware stops being your problem at build time.',
    code: 'linux/arm64 ✓   linux/arm/v7 ✓   linux/amd64 ✓',
  },
  {
    n: '03',
    kicker: 'place',
    title: 'The scheduler picks the node, not you',
    body: 'Hard constraints filter first: architecture, free RAM, GPU, reliability tier, affinity rules. Eligible nodes are then ranked on headroom and load. Pinned services never move.',
    code: 'eligible 3/5 → ranked → node-01 (home-server)',
  },
  {
    n: '04',
    kicker: 'mesh',
    title: 'Every node is a peer on an encrypted mesh',
    body: 'WireGuard between nodes, service discovery by name, ingress that follows the workload. No port forwarding, no NAT archaeology, TLS issued and renewed for you.',
    code: 'api.yourdomain.dev → mesh → whichever node holds api',
  },
  {
    n: '05',
    kicker: 'fail over',
    title: 'A missed heartbeat is a scheduling event',
    body: 'Lid closes, power blips, someone trips over the switch. Flexible services are rescheduled onto an eligible node in seconds. Pinned services raise a distinct alert instead of silently moving.',
    code: 'heartbeat missed ×3 → node-03 down → reschedule',
  },
  {
    n: '06',
    kicker: 'observe',
    title: 'One dashboard for the whole fleet',
    body: 'Node health, live placement map, aggregated logs, a unified event timeline, and alert routing to webhook, email, Discord or Slack.',
    code: 'events: 1 reschedule · 1 pinned-alert · 0 drift',
  },
]

export const FEATURES = [
  {
    tag: 'nodes',
    title: 'Node and agent management',
    body: 'Single static Go binary, under 50MB resident. Pairing tokens are short-lived and single-use; per-node credentials rotate and revoke from the dashboard if a device goes missing. Cordon and drain a node before you unplug it.',
    points: ['Auto-detected capability', 'Cordon / drain / reclaim', 'Per-node credential revocation'],
    span: 'lg',
  },
  {
    tag: 'builds',
    title: 'Multi-arch builds',
    body: 'Buildx on the control plane runner, so a Pi never has to compile anything. One tag per architecture, one image reference per service.',
    points: ['arm64 · armv7 · amd64', 'Registry push, agents pull'],
    span: 'sm',
  },
  {
    tag: 'scheduler',
    title: 'Constraint-based placement',
    body: 'Filter on hard constraints, rank on headroom, reliability tier and current load. Pin what must not move, let the rest float.',
    points: ['pinned / preferred / flexible', 'Affinity and anti-affinity', 'Manual override, always'],
    span: 'sm',
  },
  {
    tag: 'network',
    title: 'Encrypted mesh and ingress',
    body: 'Per-fleet WireGuard mesh, never shared across orgs. Public traffic terminates at your Cloudflare Tunnel or a managed subdomain and proxies over the mesh to whichever node currently holds the service.',
    points: ['No port forwarding', 'ACME / managed wildcard TLS', 'Service discovery by name'],
    span: 'lg',
  },
  {
    tag: 'resilience',
    title: 'Failover and reclaim policy',
    body: 'Heartbeat TTL in Redis detects a dark node without polling. Rescheduling is automatic for flexible services; reclaim behaviour when the node returns is yours to declare.',
    points: ['Configurable heartbeat window', 'Drift detection', 'reclaim: eager | idle | never'],
    span: 'md',
  },
  {
    tag: 'control',
    title: 'Logs, events, RBAC, audit',
    body: 'Aggregated container logs across nodes, a single event timeline, four roles from owner to viewer, and an audit log written synchronously with the mutating action so you can actually rely on it.',
    points: ['owner / admin / deployer / viewer', 'Synchronous audit writes', 'CLI and REST parity'],
    span: 'md',
  },
]

export const COMPARISON = {
  columns: [
    { key: 'fleet', name: 'Fleet OS', sub: 'your hardware, orchestrated', self: true },
    { key: 'paas', name: 'Railway · Render · Vercel', sub: 'managed PaaS' },
    { key: 'selfhost', name: 'Coolify · Dokploy · CapRover', sub: 'self-hosted PaaS' },
    { key: 'balena', name: 'Balena', sub: 'fleet device management' },
    { key: 'k8s', name: 'Kubernetes · K3s', sub: 'general orchestration' },
  ],
  rows: [
    {
      label: 'Runs on hardware you own',
      fleet: ['yes', 'Any mix of Pi, laptop, mini PC, VPS'],
      paas: ['no', 'Their compute, billed monthly'],
      selfhost: ['yes', 'Your servers'],
      balena: ['yes', 'Devices you own'],
      k8s: ['yes', 'Your servers'],
    },
    {
      label: 'Handles mismatched architectures',
      fleet: ['yes', 'Multi-arch build + arch-aware placement'],
      paas: ['n/a', 'Uniform managed runtime'],
      selfhost: ['partial', 'Builds per host, no cross-arch placement'],
      balena: ['yes', 'Strong, but assumes identical devices'],
      k8s: ['yes', 'With node selectors you maintain'],
    },
    {
      label: 'A node disappearing is a normal event',
      fleet: ['yes', 'Heartbeat loss triggers reschedule'],
      paas: ['n/a', 'Not your failure domain'],
      selfhost: ['no', 'Assumes the box is always on'],
      balena: ['partial', 'Device offline is tracked, not rescheduled'],
      k8s: ['yes', 'This is what it is for'],
    },
    {
      label: 'Different services on different devices',
      fleet: ['yes', 'Per-service constraints across a mixed fleet'],
      paas: ['n/a', ''],
      selfhost: ['partial', 'Per-host, manually assigned'],
      balena: ['no', 'Same release across the fleet'],
      k8s: ['yes', 'Full control, full complexity'],
    },
    {
      label: 'Operational weight for 2–25 nodes',
      fleet: ['low', 'One YAML file, one dashboard'],
      paas: ['low', 'Nothing to run'],
      selfhost: ['low', 'One box to maintain'],
      balena: ['medium', 'Device fleet model to learn'],
      k8s: ['high', 'The correct answer at scale, overkill here'],
    },
    {
      label: 'Cost at hobby traffic',
      fleet: ['low', 'Hardware you already bought'],
      paas: ['high', 'Recurring rent regardless of traffic'],
      selfhost: ['low', 'Free, self-hosted'],
      balena: ['medium', 'Per-device pricing above the free tier'],
      k8s: ['low', 'Free software, your time is the cost'],
    },
  ],
}

export const PLANS = [
  {
    name: 'Solo',
    price: '$0',
    unit: 'forever',
    line: 'One node, the whole deploy experience.',
    features: [
      'Single registered node',
      'git push deploys, multi-arch builds',
      'Full dashboard, logs, event timeline',
      'Managed subdomain with TLS',
      'One webhook alert channel',
    ],
    cta: 'Start with one node',
    note: 'No card. The free tier is the product, minus the fleet.',
  },
  {
    name: 'Fleet',
    price: '$12',
    unit: '/ month',
    line: 'Multi-node orchestration and everything failover implies.',
    highlight: true,
    features: [
      'Unlimited nodes, constraint-based placement',
      'Automatic failover and reclaim policies',
      'Email, Discord and Slack alert channels',
      'Team seats with RBAC and audit log',
      'Priority scheduling, extended log retention',
      'Control-plane HA',
    ],
    cta: 'Run the fleet',
    note: 'Per org, not per node. Adding a Pi should not cost money.',
  },
  {
    name: 'Self-hosted',
    price: 'Open core',
    unit: 'source-available',
    line: 'Run the coordination layer on your own metal.',
    features: [
      'Same codebase, paid gates compiled out',
      'Postgres + Redis + Nginx, no exotic deps',
      'Your registry, your secrets master key',
      'Community support',
    ],
    cta: 'Read the self-hosting docs',
    note: 'For people whose objection to the cloud is the cloud.',
  },
]

export const FOOTER_LINKS = [
  {
    heading: 'Product',
    links: [
      ['Overview', '#top'],
      ['How it works', '#how'],
      ['Scheduler', '#/docs/scheduler'],
      ['Mesh networking', '#/docs/mesh'],
      ['Failover', '#/docs/failover'],
      ['Pricing', '#pricing'],
      ['Changelog', '#/changelog'],
    ],
  },
  {
    heading: 'Developers',
    links: [
      ['Documentation', '#/docs'],
      ['fleet.yaml spec', '#/docs/fleet-yaml'],
      ['CLI reference', '#/docs/cli'],
      ['REST API', '#/docs/api'],
      ['Self-hosting guide', '#/docs/self-hosting'],
      ['Source on GitHub', '#/github'],
    ],
  },
  {
    heading: 'Company',
    links: [
      ['About', '#/about'],
      ['Writing', '#/blog'],
      ['Roadmap', '#/roadmap'],
      ['Security', '#/security'],
      ['Status', '#/status'],
      ['Contact', '#/contact'],
    ],
  },
  {
    heading: 'Community',
    links: [
      ['Discord', '#/community'],
      ['r/selfhosted', '#/community'],
      ['Homelab showcase', '#/community'],
      ['Support forum', '#/contact'],
      ['Bluesky', '#/community'],
      ['Contributing', '#/community'],
    ],
  },
]

export const LEGAL_LINKS = [
  ['Privacy', '#/legal/privacy'],
  ['Terms', '#/legal/terms'],
  ['Licence', '#/legal/licence'],
  ['Security', '#/security'],
]
