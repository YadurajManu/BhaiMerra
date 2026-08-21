# Fleet OS

git-push deploys onto hardware you already own — a Raspberry Pi, an old laptop,
a spare mini PC, optionally a rented VPS — orchestrated as one resilient pool.

See `prd.txt` for product scope and `context.txt` for the technical plan.
This README covers what is built and how to run it.

## Layout

```
fleet-os/
  control-plane/   Fastify + TypeScript + Drizzle + Postgres + Redis
  agent/           Go binary, one per node
  cli/             the fleet command
  dashboard/       React SPA — the control-plane UI
  scripts/         install.sh — one-line agent install
  www/             marketing site (Vite + React)
  docs/
```

## Status — Phase 1 of the build order in `context.txt` §11

| Area | State |
| --- | --- |
| Postgres schema (§5) | ✅ all 13 tables, migrated |
| Auth: signup / login / refresh / me | ✅ argon2id, rotating refresh tokens |
| RBAC (FR-14) | ✅ owner / admin / deployer / viewer, enforced at the API layer |
| Audit log (FR-15) | ✅ written in the same transaction as the action |
| Secret envelope encryption (FR-13) | ✅ per-secret DEK wrapped by the master key |
| Pairing tokens (FR-1) | ✅ single-use, 10 min, consumed inside the register transaction |
| Agent register / heartbeat / desired-state | ✅ |
| Heartbeat liveness + failure detection (FR-5) | ✅ Redis TTL + sorted-set sweeper |
| Agent: capability detection (FR-2) | ✅ arm64 / armv7 / amd64, linux + darwin |
| Agent: heartbeat loop with backoff | ✅ survives control-plane outages (§9) |
| Cross-compiled binaries | ✅ 5 targets, ~6 MB each |
| Install script | ✅ POSIX sh, checksum verified, systemd unit |
| fleet.yaml parsing and validation (FR-4) | ✅ every error at once, each naming the fix |
| Apply manifest → services | ✅ orphans reported, never deleted |
| Scheduler placement (§8) | ✅ filter + weighted rank, explains every rejection |
| Deploy, reschedule, placement map, event timeline | ✅ |
| Automatic rescheduling (FR-6) | ✅ flexible services move on node loss |
| Pinned services held with a distinct alert (FR-7) | ✅ |
| Multi-arch build runner (FR-3) | ✅ buildx → registry, arm64 + armv7 + amd64 |
| Agent container lifecycle | ✅ pull, run, replace, stop; reconciles to desired state |
| Deploy → build → pull → running | ✅ verified end to end |
| Alerting (FR-12) | ✅ webhook (signed), Discord, Slack; email is an interface |
| Reclaim policies (FR-9) | ✅ eager / idle / manual, applied when a node returns |
| Drift detection | ✅ reports what the node says is not running |
| CLI (FR-17) | ✅ auth, init, validate, apply, status, nodes, deploy, where, events, alerts |
| Public ingress (FR-8) | ✅ a URL that follows the service across a failover |
| Dashboard (FR-10) | ✅ sign in, overview, nodes, services, events, alerts, settings |
| git webhook → deploy | ✅ signed, fetches the pushed commit, builds and rolls out |
| GitHub App | ✅ installation tokens for private repos, repo listing |
| Mesh / ingress | ⬜ Phase 4 |
| Dashboard, CLI | ⬜ Phase 5 |

## Running it locally

Needs Postgres and Redis on their default ports, and Go 1.24+.

```bash
cd control-plane
npm install
createdb fleetos_dev
cp .env.example .env        # then set SECRETS_MASTER_KEY and JWT_SECRET
npm run db:migrate
npm run dev                 # :8080
```

```bash
cd agent
make                        # vet + test + build
./dist/fleet-agent -capabilities
```

### Public, from your own machine — one command

Everything runs locally — Postgres, Redis, registry, control plane, dashboard —
and Cloudflare Tunnel puts it on the internet without forwarding a port.

```bash
./fleet-up.sh
```

It preflights first (Docker running, secrets set, tunnel configured), starts
the stack, waits until the control plane actually answers rather than merely
started, then attaches the tunnel and prints the URLs.

```
./fleet-up.sh              start everything
./fleet-up.sh --no-tunnel  local only
./fleet-up.sh status       what is running, and where
./fleet-up.sh logs         follow the control plane
./fleet-up.sh down         stop everything (data is kept)
```

First run only: `cp deploy/.env.example deploy/.env`, fill in the secrets, and
`./deploy/cloudflare/setup.sh`. See [docs/self-hosting.md](docs/self-hosting.md).

Three hostnames, three jobs:

| | |
| --- | --- |
| `fleet.<zone>` | the dashboard (nginx, which also proxies `/api`) |
| `fleetapi.<zone>` | the control-plane API, for the CLI and agents |
| `*.fleet.<zone>` | every deployed service, via the ingress edge |

The wildcard is what makes a deployed service reachable at the hostname the
scheduler assigned it — and it means no DNS write per deploy, which would
otherwise be a rate-limited API call on the hot path. `INGRESS_ZONE` in `.env`
must match the zone in the tunnel config or the two disagree about hostnames.

Tunnel origins are set to `http2Origin: true`. QUIC is faster where it works
and unreliable on networks that treat long-lived UDP as suspicious, which
describes a lot of home ISPs — the lesson `context.txt` §3 records from
plastikworld.xyz itself.

### Or: the whole control plane in one command

```bash
cd deploy
cp .env.example .env        # fill in the three secrets it asks for
./setup-builder.sh          # QEMU emulators + a multi-arch buildx builder
docker compose up -d
```

That brings up Postgres, Redis, a registry, and the control plane — API on
:8080, public ingress on :8081. It deliberately does *not* run an agent: agents
belong on the machines you are deploying to, which is the entire point.

`REGISTRY_URL` must be reachable **from your agent machines**, so on a LAN that
is your host's IP, not `localhost`.

Pair a node:

```bash
curl -sX POST localhost:8080/auth/signup -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"a long enough passphrase"}'
# then, with the accessToken and fleet id from that response:
curl -sX POST localhost:8080/fleets/$FLEET/nodes/pair-token -H "authorization: Bearer $ACCESS"
./dist/fleet-agent --control-plane http://localhost:8080 --token flp_...
```

## Tests

```bash
cd control-plane && npm test     # 83 tests, needs Postgres + Redis
cd control-plane && npm run smoke # end-to-end against a running control plane
cd agent && go test ./...
```

`npm run smoke` walks the whole path against a live server: sign up, pair three
nodes, heartbeat, reject a bad manifest, apply a good one, preview placement,
deploy everything, then stop heartbeating for one node and assert that its
flexible services move and its pinned one does not.

`npm run e2e` goes further and uses real infrastructure: it spawns the actual
agent binary against this machine's Docker, deploys a service that builds from
source, and asserts the container comes up and serves a response.

```
✓ agent joined as "sayyestoheaven"
✓ manifest applied  hello
✓ built and scheduled onto sayyestoheaven  3.1s
✓ the agent reported the container running
✓ served a response  fleet-os says hello from aarch64
```

The control-plane suite (57 tests) includes the two integration tests
`context.txt` §12 asks for:

- **Failure detection** — three nodes registered, one stops beating; assert it
  and only it is marked down, a `node.down` event fires once, and a cordoned
  node is never swept.
- **Failover** — a node holding one flexible and one pinned service goes dark;
  assert the flexible one moves to the best eligible node, the pinned one does
  not move and raises its own alert, the old deployment is superseded rather
  than deleted, and a placement event records the winning score.

Test files run serially (`--test-concurrency=1`): they share one Postgres and
one Redis, and `sweepOnce` covers every fleet by design, so concurrent files
consume state each other is about to assert on.

## Decisions taken

The tech doc §14 asks for four confirmations. Taken as documented, with the
reasoning recorded so they can be revisited:

- **Go for the agent.** Static binaries, trivial cross-compilation, no runtime
  on the node. Rust remains a reasonable alternative; nothing in the agent's
  shape would have to change to port it.
- **Central builds for v1.** Keeps compilation off constrained nodes.
- **Mesh: undecided.** tsnet vs. a bespoke WireGuard coordinator does not block
  Phases 1–3 and is deliberately still open.
- **Open-core boundary: undecided.** Nothing built so far forecloses it.

## The scheduler

`src/scheduler/placement.ts` is a pure function over a fleet snapshot — no I/O —
so a past decision can be replayed against recorded state to explain itself.

Filtering collects rejections rather than short-circuiting: when a deploy
fails, "no eligible node" is useless and "home-server was full, thinkpad is
opportunistic, pi-5 is the wrong architecture" is actionable. Ranking weights
headroom at 0.5 because a homelab node driven into swap takes its neighbours
with it. Ties break on node id so repeated runs cannot flap.

## The dashboard

```bash
cd dashboard && npm install && npm run dev     # :5174, proxies /api to :8080
```

Same design tokens as the marketing site, imported from `www/src/index.css`
rather than retyped, so the two cannot drift.

Every page reads the real API and polls, because this is a product about
liveness. Two screens carry most of the weight:

- **Overview** leads with what needs a human. A pinned service that is down
  prints above the fold in red; everything else is a table.
- **Service detail** shows the scheduler's actual reasoning — every candidate
  node with its score, headroom, tier and load, plus who was rejected and why.
  That is the thing no competitor surfaces.

Roles change what renders, but the API is what enforces them — hiding a button
is not access control, and the Settings page says so.

## The CLI

```bash
cd cli && npm install && npm run build
node dist/src/index.js --help
```

```
$ fleet where web
would place on homeserver

NODE        SCORE   HEADROOM  RELIABILITY  LOAD  FREE
homeserver  0.7904  0.969     0.50         0.78  16.0GB
pi5         0.7748  0.938     0.50         0.78  8.0GB
vpsfra      0.6810  0.750     0.50         0.78  2.0GB
```

`fleet status` leads with what is wrong rather than burying it: a pinned
service that is down prints CRITICAL above the table, because that is the one
case a human has to act on.

`fleet doctor` is the read-only first response when something looks wrong. It
checks the signed-in account, fleet access, live nodes, Docker daemon/version,
real registry-pull results, disk pressure, reconciliation failures, deployment
failures, public HTTPS reachability, and GitHub App status. Every warning says
what Fleet cannot yet observe rather than claiming a check passed.
`fleet deploy <service>` shows its candidate node, placement reason, and
service URL before asking for confirmation; use `--plan` for a no-change
preview or `--yes` in automation.

Exit codes are a contract — `0` ok, `1` failure, `2` usage, `3` no eligible
node, `4` health check failed — so a CI step can branch on them.

## GitHub App

Private repositories need one. A GitHub **App**, not an OAuth App: an App gets
per-installation tokens that expire in an hour and cover only the repositories
you granted, where an OAuth App gets one long-lived token covering everything
that user can see — far too much for a service that clones code.

```bash
GITHUB_APP_ID=...              # public identifier
GITHUB_APP_CLIENT_ID=...       # public identifier
GITHUB_APP_PRIVATE_KEY_PATH=./github-app.pem   # the actual secret, gitignored
```

Permissions: `Contents: read`, `Metadata: read`, `Webhooks: write`. Subscribe
to `push`. Then install it on your account and choose the repositories.

Public repos work without any of this configured, so the App is optional until
you need a private one.

Installation tokens end up embedded in a clone URL, because that is the only
way `git fetch` takes credentials non-interactively. `redactRemote` strips them
before anything reaches a log — git puts the remote into its own error output,
token and all.

## Ingress

Every service gets a managed hostname, `<service>.<fleet>-<id>.<zone>`, and can
also carry its own domain. The fleet id suffix is load-bearing: fleet names are
unique per org, not globally, and the default name for everyone's first fleet
is `homelab` — without it two unrelated users collide on their first deploy.

The routing table is derived, not stored. A hostname resolves to whichever node
is running the service *right now*, looked up from the live deployment, so
there is nothing to forget to update when placement changes. That is what makes
FR-8 hold:

```
deployed to sayyestoheaven-2   url http://hello.homelab-7efe4c.fleetos.test
curl  →  fleet-os says hello from aarch64      x-fleet-node: sayyestoheaven-2
kill the agent on sayyestoheaven-2
curl  →  fleet-os says hello from aarch64      x-fleet-node: sayyestoheaven
```

The edge listens on its own port, separate from the API: it faces the internet
and the control-plane API must not. Requests stream rather than buffer, so an
upload is not bounded by proxy memory.

**What this is not, yet.** Without the mesh, a node's advertise address has to
be directly routable from the control plane. That is true on a LAN and false
through NAT, which is exactly what Phase 4b's WireGuard mesh is for. Set
`FLEET_ADVERTISE_ADDR` on the agent when the automatic choice is wrong.

## git push

`POST /webhooks/git/:fleetId` takes a GitHub-style push event, verifies the
HMAC over the raw body, matches the repository against services in that fleet,
fetches the tree at that commit shallowly, and runs the same deploy path
`fleet deploy` uses — so a push and a manual deploy cannot drift apart.

It acknowledges before building. A webhook sender times out in seconds and a
multi-arch build takes minutes; holding the connection open makes every deploy
look like a failed delivery and get retried.

Remotes are checked before they reach git: `ext::sh -c …` is a valid git
transport that executes a command, and the remote comes from user input.

## Alerting

Severity is assigned per event type rather than inferred, because the whole
point is that a routine reschedule and a pinned service being down are not the
same news:

```
[warning ] node.down                   Node homeserver stopped responding after 3 missed heartbeats.
[info    ] service.rescheduled         web moved to pi5 automatically.
[info    ] service.rescheduled         img-proxy moved to vpsfra automatically.
[critical] service.pinned_unavailable  postgres is DOWN and was not moved — it is pinned to a node that went offline.
```

Webhook payloads are HMAC-signed (`x-fleet-signature`) so a receiver can verify
the alert came from your control plane. An unauthenticated webhook saying "your
database is down" is a way to make someone panic on demand.

Delivery never throws: an unreachable Discord webhook must not stop the sweeper
finding the next dead node, nor the other channels for the same event. 5xx and
429 are retried with backoff; other 4xx are not, because a bad URL stays bad.

`POST /fleets/:id/alert-rules/test` fires a sample event so a rule can be
verified before an incident rather than during one.

## Known gaps

- `connectivity` is reported as `unknown` rather than guessed — a wrong value
  would make the control plane pick the wrong ingress path.
- No git webhook yet: deploys are triggered through the API, and the build
  runner reads a checkout that is already on disk. Cloning at deploy time is
  the remaining piece of "git push, get a URL".
- Ingress does not exist. A deployed container is reachable on the node, not
  at a public URL — that is Phase 4 (mesh, tunnels, TLS).
- Email alerts are an interface with no provider wired in; webhook, Discord
  and Slack deliver for real.
- `fleet logs <service> --follow` exposes a bounded, live agent-reported tail.
  It is intentionally not durable log storage; use an external log sink for
  retention, search, or compliance.
- Concurrent control planes (PRD 7.5 HA) are safe for *detection* — marking a
  node down is a single conditional UPDATE ... RETURNING, so only one instance
  gets the row — but two instances rescheduling different downed nodes at the
  same moment could both place onto the same target and overcommit it. Needs a
  per-fleet scheduling lock before HA is real.
# BhaiMerra
# BhaiMerra
