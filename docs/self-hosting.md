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

Fleet OS derives the direct agent API hostname as `https://fleetapi.<zone>`.
Override it with `PUBLIC_API_URL` only if you use a different hostname. Agents
call routes such as `/agent/register` at the API root; `fleetapp.<zone>` only
proxies browser calls below `/api`.

```bash
PUBLIC_API_URL=https://fleetapi.example.com
```

Getting this wrong is the most common setup failure: the control plane pushes
an image successfully, and then every agent fails to pull it.

### Authorise the zone

`cloudflared`'s certificate is scoped to **one** zone, chosen when you log in.
If you already use cloudflared for another domain, log in to a separate file
so the existing certificate survives:

```bash
TUNNEL_ORIGIN_CERT=~/.cloudflared/fleet-cert.pem cloudflared tunnel login
```

This matters more than it looks. Using a certificate for the wrong zone does
not fail — cloudflared treats the hostname as *relative* and appends its own
zone, so `fleet.example.com` silently becomes
`fleet.example.com.otherzone.com`. `setup.sh` detects that and refuses.

`--origincert` is a flag on `tunnel`, not on `login` and not global, so its
position on the command line is easy to get wrong. `TUNNEL_ORIGIN_CERT` is the
same setting without the ambiguity.

```bash
ORIGINCERT=~/.cloudflared/fleet-cert.pem ./deploy/cloudflare/setup.sh
```

Idempotent — re-running reuses a tunnel of the same name instead of creating
duplicates.

### Certificates and subdomain depth

Cloudflare's free Universal SSL covers the apex and **one** level of
subdomain. `app.fleet.example.com` is two levels deep and has no certificate,
so it fails TLS in the browser with nothing useful in the error.

Either keep everything one level deep — `fleet.example.com`,
`fleetapp.example.com`, `fleetapi.example.com` — or buy Advanced Certificate
Manager ($10/month per zone).

This is also why managed service hostnames are a single label
(`web-homelab-7efe4c.fleet.example.com`, not `web.homelab-7efe4c.fleet...`):
one wildcard certificate covers exactly one level.

## Hostnames

| | |
| --- | --- |
| `fleet.<zone>` | dashboard (nginx, which also proxies `/api`) |
| `fleetapi.<zone>` | control-plane API, for the CLI and agents |
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

The control plane serves its own installer and agent binaries — a self-hosted
install has no CDN behind it, so the command it prints points at *your* server,
not at a download host that only exists for the hosted product:

```
curl -fsSL https://fleetapi.example.com/install | sh -s -- --token flp_...
```

Build the binaries it serves with:

```bash
make -C agent dist
```

`GET /install/manifest` lists what your control plane can currently hand out.

Agents reach the control plane at `fleetapi.<zone>`, so they work from
anywhere. **Ingress reaches agents by their address**, which today means the
control plane and the nodes need to be on the same network. A node in another
building needs the reverse tunnel in [ADR 0001](adr/0001-mesh-and-ingress.md).

### macOS + Docker Desktop

When both the control plane and agent run on the same Mac, Docker Desktop
places the control plane in a VM. The Mac's LAN address is not always
reachable from that VM, even though the agent and Docker containers are
healthy. Pair the agent with Docker Desktop's host gateway instead:

```bash
curl -fsSL https://fleetapi.example.com/install | sh -s -- \
  --token flp_... --advertise-addr host.docker.internal --reset
```

If the agent is already paired, preserve that node identity and update only
the route configuration instead (no new token, no new node):

```bash
curl -fsSL https://fleetapi.example.com/install | sh -s -- \
  --configure --advertise-addr host.docker.internal
```

`--advertise-addr` is only the address Fleet ingress uses to reach the node;
it does not change how the agent contacts the API. Use it only when the
automatic LAN address is wrong. The reverse-tunnel ingress work will remove
this requirement for nodes behind NAT.

### Who starts Docker

A node cannot run workloads without a container runtime, so the agent will help
bring one up — but it will not argue with you about it. `--docker-autostart`
sets the policy, and the installer writes it into the service definition so it
survives restarts:

| Value | Behaviour |
| --- | --- |
| `cold` (default) | Start the runtime only if this node has never had a working one. Once Docker has been seen healthy, quitting it is treated as a decision and left alone. |
| `always` | Start it whenever it is found down. |
| `never` | Only report. Docker is entirely yours to start and stop; the installer will not touch it either. |

```bash
curl -fsSL https://fleetapi.example.com/install | sh -s -- \
  --token flp_... --docker-autostart never
```

The decision is recorded in `docker-autostart.json` next to `agent.json`, which
is what makes `cold` hold across an agent restart.

To change the policy on a node that is already paired, re-run the installer with
`--configure`. It rewrites the whole service definition, so pass any
`--advertise-addr` you set originally or it will be dropped:

```bash
curl -fsSL https://fleetapi.example.com/install | sh -s -- \
  --configure --docker-autostart never --advertise-addr host.docker.internal
```

Or edit `FLEET_DOCKER_AUTOSTART` in the service definition directly:

- Linux — `/etc/systemd/system/fleet-agent.service`, then
  `systemctl daemon-reload && systemctl restart fleet-agent`
- macOS — `~/Library/LaunchAgents/dev.fleet-os.agent.plist`, then
  `launchctl unload` and `launchctl load` it

If Docker keeps reopening after you quit it, the node is almost certainly
running an agent installed before this policy shipped. Reinstall it, or check
`journalctl -fu fleet-agent` / `~/Library/Application Support/fleet-os/agent.log`
for a repeating credential-rejected error — an agent whose node was deleted from
the fleet used to restart every few seconds and reopen Docker on each pass.

## GitHub push deploys

Fleet can deploy a repository at the exact commit GitHub reports. Add a
`repo:` URL to every service built from that repository, apply the manifest
once in the dashboard, then add the fleet's webhook URL shown in **Settings →
GitHub deploys** to that GitHub repository. Select **Just the push event** and
use JSON payloads.

For private repositories, create a GitHub App with **Contents: Read-only** and
**Webhooks: Read & write**, and set these in `deploy/.env` before restarting
the control plane:

```dotenv
WEBHOOK_SECRET=a-long-random-shared-secret
GITHUB_APP_ID=123456
GITHUB_APP_SLUG=your-app-slug
GITHUB_APP_PRIVATE_KEY=/absolute/path/to/github-app.pem
PUBLIC_DASHBOARD_URL=https://dashboard.example.com
```

Then set two URLs on the App itself. Both are shown ready to copy in
**Settings → GitHub workspace**:

| Field in the App's settings | Value |
| --- | --- |
| Setup URL | `https://<your-api>/github/setup` |
| Webhook URL | `https://<your-api>/webhooks/github` |

The Setup URL is what records **which organisation** installed the App. A
GitHub App has a single installation list shared by every tenant of the
control plane that runs it, so an installation that arrives without going
through this flow belongs to nobody, and Fleet refuses to use it rather than
guessing. The Webhook URL is the other half: it delivers installation events,
so uninstalling the App from a GitHub account revokes Fleet's access to it
immediately and deletes the repository connections that depended on it.

An installation is claimed by exactly one organisation. If a second
organisation on the same control plane tries to connect an account that is
already connected, it is refused — it cannot list that account's repositories,
cannot connect one, and cannot cause a build to clone with its token.

The dashboard reports whether Fleet can reach the App and exposes the exact
webhook endpoint. A push then fetches that commit, applies its root
`fleet.yaml`, builds the configured services, and deploys them. Never commit
the private key or webhook secret.

Once configured, **Settings → GitHub workspace** provides the day-to-day
connection flow: **connect account** installs the App and binds it to your
organisation, then you filter the repositories it can access and explicitly
connect a repository to a fleet.
For each connection you choose a watched branch and the manifest path. The
first push can create services from that manifest; later pushes apply the
exact pushed configuration before building and deploying. Disconnecting a
repository stops future webhook deployments but never deletes a live service.

## Diagnose, inspect logs, and recover

Fleet agents report runtime facts on their normal outbound heartbeat. No
inbound Docker or SSH port is opened. Start incident response with:

```sh
fleet doctor
fleet logs <service> --follow
fleet deployments <service>
```

`fleet doctor` shows the daemon/version seen by every agent, the result of the
last real image pull (including registry authentication failures), disk use,
and the latest reconciliation error. `fleet logs` is a live, bounded container
tail; it refreshes every two seconds and is not a retained logging system.

Recovery operations are immutable: they create a new deployment record instead
of overwriting the old one, so the dashboard timeline remains trustworthy.

```sh
fleet restart <service>              # recreate the current image on its node
fleet rollback <service>             # use the most recent earlier release
fleet rollback <service> <release>   # choose a deployment ID explicitly
```

Use the Dashboard **Doctor** page for the same node facts, copyable repair
commands, and the Dashboard **Logs** page to choose a service and view its
current node tail. The service detail page includes restart/rollback controls
and a rollback confirmation dialog.

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

The control plane migrates on boot and refuses to start if it cannot — a
container serving against an un-migrated database answers every request with
an internal error, and the cause is three layers down. Migrations are
forward-only, so snapshot the database first.

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

**`/healthz` says `postgres: false`.** The control plane is up but cannot
reach the database. Check `POSTGRES_PASSWORD` matches between the two, and
`docker compose logs control-plane` for the migration line.

**The tunnel will not connect: `failed to dial to edge with quic`.** The
network is dropping UDP/443. Add `protocol: http2` to the tunnel config — it
is the default in the shipped one for this reason.

**DNS records appear with two domains stuck together.** The certificate is for
a different zone. Log in again with `--origincert` for the right one, and
delete the junk records from the Cloudflare dashboard.

**The tunnel connects but hostnames 404.** `INGRESS_ZONE` and the tunnel
config disagree. They must be the same zone.
