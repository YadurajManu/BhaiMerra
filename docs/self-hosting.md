# Self-hosting Fleet OS

Everything runs on one machine you own. Cloudflare Tunnel puts it on the
internet without forwarding a port or exposing anything on your router.

## What you need

- Docker (Desktop on macOS, Engine on Linux)
- A domain on Cloudflare
- `cloudflared`, logged in: `brew install cloudflared && cloudflared tunnel login`

Postgres, Redis and the registry all run as containers. You do not need to
install them.

## One command

```bash
./fleet-up.sh
```

That starts the stack, waits until the control plane is actually answering —
not merely started — and attaches the tunnel.

```
./fleet-up.sh              start everything
./fleet-up.sh --no-tunnel  local only, no public hostnames
./fleet-up.sh status       what is running, and where
./fleet-up.sh logs         follow the control plane
./fleet-up.sh down         stop everything (data is kept)
```

## First run

```bash
cd deploy
cp .env.example .env
```

Fill in three secrets:

```bash
openssl rand -hex 32       # JWT_SECRET
openssl rand -base64 32    # SECRETS_MASTER_KEY
openssl rand -hex 16       # POSTGRES_PASSWORD
```

> **Back up `SECRETS_MASTER_KEY` somewhere else.** Lose it and every stored
> secret is unrecoverable — it is not derivable from the database and it is
> not stored in it.

Then set `REGISTRY_URL` to an address **your agent machines can reach**. On a
LAN that is this machine's IP, never `localhost`:

```bash
REGISTRY_URL=192.168.1.20:5001
```

Getting this wrong is the most common setup failure: the control plane pushes
an image successfully, and then every agent fails to pull it.

Set up the tunnel once:

```bash
./deploy/cloudflare/setup.sh
```

It is idempotent — re-running reuses a tunnel of the same name instead of
creating duplicates.

## Hostnames

| | |
| --- | --- |
| `fleet.<zone>` | dashboard (nginx, which also proxies `/api`) |
| `api.fleet.<zone>` | control-plane API, for the CLI and agents |
| `*.fleet.<zone>` | every deployed service |

The wildcard is what lets a deploy hand back a working URL without writing
DNS. Per-service records would put a rate-limited API call on the deploy path.

`INGRESS_ZONE` in `deploy/.env` must match the zone in the tunnel config, or
the two disagree about what a service is called and nothing resolves.

## Adding a node

```bash
fleet nodes pair
```

Run the printed line on the machine you want to add. The token is single-use
and expires in ten minutes.

Agents reach the control plane at `api.fleet.<zone>`, so they work from
anywhere. **Ingress reaches agents by their address**, which today means the
control plane and the nodes need to be on the same network. A node in another
building needs the reverse tunnel in [ADR 0001](adr/0001-mesh-and-ingress.md).

## Ports

| Port | Service | Exposed |
| --- | --- | --- |
| 8080 | control-plane API | tunnel |
| 8081 | ingress edge | tunnel |
| 8082 | dashboard | tunnel |
| 5001 | registry | LAN only — agents pull from it |
| 5432 | Postgres | container network only |
| 6379 | Redis | container network only |

Postgres and Redis are deliberately not published. Nothing outside the compose
network needs them, and an exposed database is how homelabs end up in a breach
report.

## Backups

State lives in Docker volumes:

```bash
docker run --rm -v fleet-os_pgdata:/data -v "$PWD":/out debian \
  tar czf /out/fleet-pgdata-$(date +%F).tar.gz -C /data .
```

Back up `SECRETS_MASTER_KEY` separately from the database. Together they are
everything; apart, neither is enough.

## Upgrading

```bash
git pull && ./fleet-up.sh
```

Migrations run on boot and are forward-only. Snapshot the database first.

## When something is wrong

```bash
./fleet-up.sh status
./fleet-up.sh logs
cat deploy/.tunnel.log
```

**Agents cannot pull images.** `REGISTRY_URL` is probably `localhost`. It must
be an address the agent can reach.

**A service deploys but its URL 502s.** The container is up but the edge
cannot reach the node. Check the node is on the same network as the control
plane, and that `advertiseAddr` on the node is right — override it with
`FLEET_ADVERTISE_ADDR` on the agent.

**The tunnel connects but hostnames 404.** `INGRESS_ZONE` and the tunnel
config disagree. They must be the same zone.
