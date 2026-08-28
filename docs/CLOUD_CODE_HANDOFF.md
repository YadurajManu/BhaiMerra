# Fleet OS — Cloud Code handoff

**Prepared:** 21 August 2026  
**Branch:** `feat/phase-1-control-plane-and-agent`  
**Latest commit:** `ab6de86 feat: add agent diagnostics logs and recovery`

This document is the handoff for continuing the Fleet OS implementation. It
describes what is complete in the working tree, the contracts Cloud Code must
preserve, and the next safe implementation/deployment work. It contains no
credentials, pairing tokens, or private keys.

## Product state

Fleet OS is a self-hosted control plane for deploying services to user-owned
machines. The deployed public origins currently used by the product are:

| Surface | Origin |
| --- | --- |
| Dashboard | `https://fleetapp.plastikworld.xyz` |
| Control plane / installer | `https://fleetapi.plastikworld.xyz` |
| Marketing site and docs | `https://fleet.plastikworld.xyz` |

Architecture:

```text
dashboard / CLI / GitHub webhook
             │ HTTPS
             ▼
 control-plane (Fastify + Postgres + Redis)
             ▲ outbound HTTPS only
             │
 fleet-agent (Go) ── Docker daemon ── service containers
```

Agents never accept inbound connections. Runtime diagnostics and live log tails
move from agent to control plane in the normal outbound heartbeat. Do not add
SSH, Docker TCP, or other inbound node access as a shortcut.

## Delivered work

### 1. Onboarding, pairing, and CLI profile

Completed in commits `e38918f`, `3631740`, and `6071803`.

- Fixed pairing-token creation: the CLI now sends a JSON body when it calls the
  Fastify pair-token route. The former empty-body request produced a generic
  error.
- Hosted CLI default API is `https://fleetapi.plastikworld.xyz`.
- `fleet auth login` stores the account/profile locally and supports a selected
  fleet.
- Added `fleet config show` (safe output; never prints bearer credentials).
- Added `fleet use <fleet>` to choose the default fleet.
- Installer supports an existing agent state without re-pairing unnecessarily.
- Self-hosting documentation now explains correct hosted/self-hosted install,
  Docker Desktop on macOS, node pairing, and recovery from stale agent state.

Important command flow:

```sh
fleet auth login
fleet nodes pair
# Run the generated curl | sh command on the machine being paired.
fleet status
```

### 2. GitHub integration and push deploys

Completed in commits `1aaff79` and `5fa23e8`.

- GitHub App based access, not broad OAuth access.
- GitHub workspace UI in Dashboard **Settings**:
  - list installed GitHub accounts/organisations;
  - browse/filter repositories available to the App;
  - connect a repository to the Fleet;
  - choose watched branch and manifest path;
  - disconnect without deleting a live service.
- GitHub push webhook verifies signatures and deploys the exact pushed commit.
- A pushed manifest is applied before services are built/deployed.
- Private repository support relies on GitHub App installation tokens and
  read-only Contents access. Errors redact credentials.
- Required deployment configuration is documented in
  [`docs/self-hosting.md`](./self-hosting.md): `WEBHOOK_SECRET`, GitHub App ID,
  private-key path, and callback/webhook setup.

### 3. Plan-first CLI operations

Completed in commit `3b7dcf6`.

- `fleet doctor`: account, permission, node, agent-version, deployment,
  ingress, and GitHub diagnostics.
- `fleet deploy <service>` now shows a plan before mutation:
  source, target node, score/reason, and public URL.
- `fleet deploy <service> --plan` / `--dry-run`: no-change placement preview.
- `fleet deploy <service> --yes`: non-interactive automation mode.
- `fleet deployments <service>` shows deployment history and failure reason.

All structured read operations should preserve `--json` behaviour as new CLI
work is added. Do not output access tokens, pairing tokens, or secret values.

### 4. Agent diagnostics and runtime telemetry

Completed in commit `ab6de86`.

New agent code:

- [`agent/internal/diagnostics/reporter.go`](../agent/internal/diagnostics/reporter.go)
- extended heartbeat types in
  [`agent/internal/client/client.go`](../agent/internal/client/client.go)
- sampler integration in
  [`agent/internal/sampler/sampler.go`](../agent/internal/sampler/sampler.go)

Every heartbeat now includes:

| Telemetry | Meaning |
| --- | --- |
| `docker_available` | Actual Docker daemon ping result. |
| `docker_version`, `docker_api_version` | Docker-reported version when reachable. |
| `docker_error` | Bounded error detail when the daemon is unavailable. |
| `registry_status` | `ok`, `failed`, or `not_tested`. `ok` is only set after an actual image pull during reconciliation. |
| `registry_error` | Last pull failure (including authentication/registry errors). |
| `last_reconcile_error` | Most recent error that prevented desired state from converging. |
| `disk_used_mb` | Node disk use; evaluated relative to the registered node disk capacity. |
| `logs` | Per-service bounded Docker log-tail snapshots. |

The agent captures up to 160 Docker log lines per desired service after a
reconciliation pass. The control plane limits each uploaded tail to 32 KiB,
and heartbeats are retained only as the current Redis snapshot. This is live
debugging telemetry, **not** durable log storage.

The agent default control plane fallback was also updated to the hosted API:
`https://fleetapi.plastikworld.xyz`.

### 5. Control-plane API additions

Completed in commit `ab6de86`.

Heartbeat validation and storage were extended in:

- [`control-plane/src/api/agent.routes.ts`](../control-plane/src/api/agent.routes.ts)
- [`control-plane/src/heartbeat/tracker.ts`](../control-plane/src/heartbeat/tracker.ts)

The node endpoint now exposes runtime facts through:

```text
GET /fleets/:fleetId/nodes
```

Each node `telemetry` includes `runtime`, container state, resource usage, and
heartbeat age. Existing agents that have not yet been updated remain accepted:
the new heartbeat fields have safe defaults.

New service routes in
[`control-plane/src/api/services.routes.ts`](../control-plane/src/api/services.routes.ts):

| Endpoint | Purpose |
| --- | --- |
| `GET /services/:serviceId/logs` | Latest heartbeat-reported log tail for the current service node. Optional `?node=<uuid>`. |
| `POST /services/:serviceId/restart` | Creates a new `deploying` record using the current artifact/node/port. |
| `POST /services/:serviceId/rollback` | Restores the previous successful artifact, or an explicit `{ deploymentId }`. |

Recovery is intentionally immutable:

1. Current `running`/`deploying` deployment is marked `superseded`.
2. A new `deploying` record is inserted with the selected artifact.
3. The agent sees the new desired deployment ID and replaces the container.
4. The agent heartbeat promotes it to `running` only when the container is
   actually running.

This keeps the deployment history/audit trail accurate. Do not mutate old
deployment records to fake a rollback.

`GET /healthz` also exposes `version`, sourced from
`CONTROL_PLANE_VERSION` (default `0.1.0`).

### 6. CLI diagnostics, logs, and recovery

Completed in commit `ab6de86`.

New commands:

```sh
fleet doctor
fleet logs <service>
fleet logs <service> --follow
fleet logs <service> --since 1h
fleet deployments <service>
fleet restart <service>
fleet rollback <service>
fleet rollback <service> <deployment-id>
```

Behaviour details:

- `fleet doctor` now consumes the real node telemetry. It reports Docker
  availability/version, real registry-pull status, disk pressure, and the last
  reconciliation error per node.
- `fleet logs --follow` polls the bounded current tail every two seconds and
  prints only the new suffix where possible. It requires an interactive TTY.
- `--since` is accepted with a clear message that it is constrained by the
  current retained tail; it must not be represented as historical log search.
- Restart and rollback wait for the new deployment to report `running` unless
  `--no-wait` is supplied. Rollback asks for confirmation unless `--yes` is
  supplied.

### 7. Dashboard operations UX

Completed in commit `ab6de86`.

New pages:

- [`dashboard/src/pages/Doctor.tsx`](../dashboard/src/pages/Doctor.tsx)
  - green/yellow/red checks based on real agent facts;
  - node-specific heartbeat, Docker, registry, disk and reconciliation checks;
  - GitHub App status;
  - copyable repair commands.
- [`dashboard/src/pages/Logs.tsx`](../dashboard/src/pages/Logs.tsx)
  - service selector with current node context;
  - automatically refreshing live tail every two seconds.

Service details now include:

- live log tail;
- deployment timeline with failure reason;
- Restart control;
- Rollback control with an explicit browser confirmation modal.

Navigation now includes **Doctor** and **Logs**. All API calls use the
dashboard's existing session refresh path in `dashboard/src/lib/api.ts`.

### 8. Documentation and public site

Updated:

- [`docs/self-hosting.md`](./self-hosting.md): correct hosted install path,
  GitHub configuration, diagnostics/logs/recovery operations.
- [`README.md`](../README.md): operator feature summary and accurate live-log
  limitation.
- [`www/src/lib/pages.js`](../www/src/lib/pages.js): CLI reference advertises
  logs, restart, and rollback.

## Validation already run

These commands passed before the latest commit:

```sh
cd agent && go test ./...
cd control-plane && npm run typecheck && npm test -- --runInBand
cd cli && npm run typecheck && npm run test
cd dashboard && npm run build
cd www && npm run build
git diff --check
```

Control plane suite result: **136 passing tests**.

## Deployment requirements for Cloud Code

The source commit is complete, but new functionality is not live until all
three relevant artifacts are rebuilt/deployed:

1. Rebuild/restart the control-plane image so it accepts and serves telemetry
   and recovery/log endpoints.
2. Rebuild/restart the dashboard image so Doctor/Logs/recovery controls appear.
3. Cross-compile and publish updated `fleet-agent` binaries to `agent/dist`,
   then make them available at `/install`. Existing nodes must update/reinstall
   their agent before Docker/registry/log telemetry appears.
4. Rebuild the `www` image if the public CLI documentation is deployed there.

When deploying a self-hosted control plane, set an explicit release value:

```dotenv
CONTROL_PLANE_VERSION=0.1.0
```

Use a different version for the next release, and keep agent/control-plane
version compatibility visible in Doctor rather than silently assuming it.

Post-deploy smoke test:

```sh
fleet auth login
fleet doctor
fleet logs smoke --follow
fleet deployments smoke
fleet restart smoke
fleet rollback smoke --yes
```

Expected outcomes:

- Doctor shows Docker and disk facts for the paired node.
- Registry is `not tested` until an image pull occurs; it becomes `ok` only
  after a successful pull, or `failed` with the actual pull error.
- Logs show output only after the service exists and agent reports a tail.
- Restart/rollback create a new timeline entry and wait for `running`.

## Constraints to preserve

- Never put raw secrets, pairing tokens, agent credentials, GitHub tokens, or
  deployment secrets in CLI/dashboard output, audit metadata, or log tails.
- Keep agent communications outbound-only.
- Keep heartbeat payloads bounded. Do not turn Redis heartbeat state into a
  permanent logging database.
- Do not mark registry health green without a real pull result.
- Do not overwrite deployment history during recovery.
- Role checks belong in control-plane route guards, not only in dashboard UI.
- Preserve `--json`, `--yes`, `--plan`/`--dry-run`, narrow-terminal-safe
  rendering, `NO_COLOR`, and stable CLI exit-code conventions for future CLI
  changes.

## Recommended next implementation sequence

1. **Release/update orchestration**: add a safe agent update command and
   version compatibility policy. Existing agents will not report new telemetry
   until they are upgraded.
2. **Durable log destination**: retain the current live-tail UX, but add an
   optional Loki/OTel/vector-style sink for searchable historical logs.
3. **Explicit registry probe configuration**: use a configured probe image or
   artifact only when authorised; do not pull arbitrary images in background.
4. **Deployment tests**: add API integration tests for restart/rollback/log
   retrieval and agent unit tests for reporter state transitions.
5. **Recovery policy UX**: add canary/health window and automatic rollback only
   after an explicit policy is designed and audited.

## Commit history relevant to this handoff

| Commit | Summary |
| --- | --- |
| `ab6de86` | Agent diagnostics, live log tails, recovery APIs/CLI/dashboard, docs. |
| `3b7dcf6` | CLI doctor, selected fleet/config, deploy planning. |
| `6071803` | Pair-token request fix. |
| `3631740` | Hosted onboarding/self-hosting documentation alignment. |
| `5fa23e8` | GitHub workspace dashboard and connection management. |
| `1aaff79` | GitHub push deployment flow. |
| `c8c12ab` | Landing page aligned with real onboarding. |
| `e38918f` | Pairing and CLI onboarding polish. |
