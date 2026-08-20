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
  dashboard/       React SPA                       (not started)
  cli/             the fleet command               (not started)
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
| Scheduler placement (§8) | ✅ filter + weighted rank, explains every rejection |
| Automatic rescheduling (FR-6) | ✅ flexible services move on node loss |
| Pinned services held with a distinct alert (FR-7) | ✅ |
| git-push deploy + multi-arch build | ⬜ Phase 2 — needs the Docker daemon |
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
cd control-plane && npm test    # 23 tests, needs Postgres + Redis
cd agent && go test ./...
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

## Known gaps

- The Docker module is stubbed. `sampler.New(version, nil)` reports no
  containers; the interface is in place, the implementation is Phase 2.
- `connectivity` is reported as `unknown` rather than guessed — a wrong value
  would make the control plane pick the wrong ingress path.
- Rescheduling writes the new deployment row, but nothing yet **pulls and
  starts the container** — that needs the Docker module and a registry.
- Reclaim policies are stored per fleet and service but not yet applied when a
  node returns (PRD 7.5).
- Concurrent control planes (PRD 7.5 HA) are safe for *detection* — marking a
  node down is a single conditional UPDATE ... RETURNING, so only one instance
  gets the row — but two instances rescheduling different downed nodes at the
  same moment could both place onto the same target and overcommit it. Needs a
  per-fleet scheduling lock before HA is real.
# BhaiMerra
# BhaiMerra
