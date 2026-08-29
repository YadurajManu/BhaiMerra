# Fleet OS

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Build](https://github.com/YadurajManu/BhaiMerra/actions/workflows/ci.yml/badge.svg)](https://github.com/YadurajManu/BhaiMerra/actions)
[![Latest release](https://img.shields.io/github/v/release/YadurajManu/BhaiMerra)](https://github.com/YadurajManu/BhaiMerra/releases)
[![Go 1.24+](https://img.shields.io/badge/go-1.24%2B-00ADD8.svg)](https://go.dev/)
[![Node 20+](https://img.shields.io/badge/node-20%2B-339933.svg)](https://nodejs.org/)

Fleet OS turns the computers you already own into one deploy target. Push a repository and it builds the declared services, places each one on a node that can run it, exposes a stable HTTPS hostname, and reschedules flexible workloads when a Raspberry Pi, laptop, or spare VPS disappears. It is for homelabs, small teams, and operators who need useful orchestration without replacing their hardware or pretending that every node is identical.

## Why Fleet OS

Coolify, Dokploy, and CapRover are excellent single-server deployment tools, but their scheduling model assumes one stable host (or a fairly uniform cluster). Balena assumes a fleet of similarly managed devices. Fleet OS makes heterogeneous, intermittently connected hardware the design centre: capability discovery is reported by agents, placement explains rejected nodes, and pinned stateful services are treated differently from movable stateless services.

## What it provides

- GitHub push deployments at the exact pushed commit, including private-repository access through a GitHub App.
- `fleet.yaml` validation, dry-run placement plans, architecture-aware builds, and registry-backed image rollout.
- Weighted scheduling across CPU, memory headroom, reliability tier, tags, GPU, affinity, and anti-affinity constraints.
- Heartbeat-based liveness, cordon/drain controls, automatic failover for flexible services, and explicit handling for pinned services.
- Agent runtime telemetry: Docker availability/version, registry pull status, disk pressure, reconciliation errors, and bounded log tails.
- CLI and dashboard workflows for health checks, logs, deployments, restart, rollback, events, and signed alerts.
- Self-hosted control plane with Postgres, Redis, a local registry, and optional Cloudflare Tunnel ingress.

## Architecture

The control plane owns identity, fleet state, scheduling, builds, ingress routes, and deployment history. A small Go agent runs on each node, reports capabilities and heartbeats over outbound HTTPS, and reconciles the desired container state locally; it never requires an inbound Docker or SSH port. See [Architecture](docs/ARCHITECTURE.md) for the data flow and failure model.

## Quickstart

Install the CLI:

```bash
npm install -g @yadurajfleetos/cli
fleet auth login
```

Create a fleet and pair a node. `fleet nodes pair` prints a single-use command; run that command on the Raspberry Pi, laptop, or VPS you want to add:

```bash
fleet nodes pair
# run the printed curl ... --token flp_... command on the node
fleet status
```

In a repository with a `Dockerfile` (or let Fleet scaffold one), declare a service and push it:

```bash
fleet init
# review fleet.yaml, then:
fleet validate
fleet up web                 # apply, build, deploy, wait for running, print URL
# or use separate, reviewable steps:
fleet apply
fleet deploy web
git add fleet.yaml Dockerfile
git commit -m "deploy web"
git push
```

For a self-hosted control plane, follow [Deployment](docs/DEPLOYMENT.md).

## Stack

- Go agent with static cross-compiled binaries for Linux and macOS (`arm64`, `armv7`, `amd64`).
- TypeScript control plane on Fastify, Drizzle ORM, Postgres, Redis, and Docker Buildx.
- TypeScript CLI distributed as an npm package.
- React dashboards and a Vite marketing site, served by nginx containers.
- Docker Compose for local/self-hosted operation; Cloudflare Tunnel for optional public ingress.

## Documentation

| Guide | Contents |
| --- | --- |
| [Architecture](docs/ARCHITECTURE.md) | Control plane, agents, scheduling, heartbeats, and failover |
| [Data model](docs/DATA_MODEL.md) | Entities, lifecycle, and relationships |
| [API and CLI](docs/API.md) | Current routes and command reference; proposed additions are marked |
| [Deployment](docs/DEPLOYMENT.md) | Self-host the control plane and add nodes |
| [Contributing](docs/CONTRIBUTING.md) | Local setup, tests, branches, commits, and pull requests |
| [fleet.yaml](docs/fleet-yaml-spec.md) | Manifest schema and placement semantics |
| [Self-hosting reference](docs/self-hosting.md) | Tunnel, registry, GitHub, diagnostics, and backup details |

## License

Fleet OS is released under the [MIT License](LICENSE).

## Contributing

Bug reports, design discussions, and pull requests are welcome. Read [CONTRIBUTING.md](docs/CONTRIBUTING.md) before opening a change.
