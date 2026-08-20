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
| Scheduler placement (§8) | ⬜ Phase 2 |
| git-push deploy + multi-arch build | ⬜ Phase 2 |
| Automatic rescheduling (FR-6) | ⬜ Phase 3 — detection is done, the move is not |
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

The control-plane suite includes the multi-node failure-detection test from
`context.txt` §12: three nodes registered, one stops beating, assert that it
and only it is marked down, that a `node.down` event fires once, and that a
cordoned node is never swept.

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

## Known gaps

- The Docker module is stubbed. `sampler.New(version, nil)` reports no
  containers; the interface is in place, the implementation is Phase 2.
- `connectivity` is reported as `unknown` rather than guessed — a wrong value
  would make the control plane pick the wrong ingress path.
- Detection is done but **rescheduling is not**: a node going down is recorded
  and alerted on, and nothing moves yet. That is FR-6, Phase 3.
# BhaiMerra
