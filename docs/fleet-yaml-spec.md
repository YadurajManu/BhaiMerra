# fleet.yaml

One file at the root of your repository describes what to deploy and where it
may run. It is validated on every apply, and every error names the fix.

```yaml
fleet: homelab

defaults:                     # merged under every service
  reclaim: idle

services:
  web:
    repo: https://github.com/you/homelab.git
    build: ./apps/web         # or image: — one of the two, never both
    placement: flexible
    resources: { ram: 512Mi, cpu: 0.5 }
    domain: web.yourdomain.dev
    health: { path: /healthz, timeout: 5s, interval: 15s }
    anti_affinity: [img-proxy]

  postgres:
    image: postgres:16
    placement: pinned
    node: node-03
    volume: pgdata
    secrets: [POSTGRES_PASSWORD]
```

## Top level

| Key | Required | Meaning |
| --- | --- | --- |
| `fleet` | yes | The fleet this repository deploys into. |
| `services` | yes | Service name → definition. At least one. |
| `defaults` | no | Merged beneath every service; a service always wins. |

Service names are lowercase letters, digits and hyphens, and cannot start or
end with a hyphen.

## Service keys

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `build` | path | — | Build context. Mutually exclusive with `image`. |
| `repo` | repository URL | — | Enables GitHub push deploys for this service. Fleet fetches this commit's `fleet.yaml` before building. |
| `image` | reference | — | Prebuilt image. Skips the build step. |
| `placement` | enum | `flexible` | `flexible`, `preferred`, `pinned`. |
| `node` | node name | — | Required for `pinned`; invalid for `flexible`. |
| `resources.ram` | quantity | `256Mi` | Hard constraint during filtering, and enforced as the container's memory limit. |
| `resources.cpu` | number | `0.25` | Used for ranking, not enforced as a cap. |
| `arch` | list | all | `arm64`, `armv7`, `amd64`. Empty means any. |
| `min_reliability` | enum | `any` | `any`, `opportunistic`, `standard`, `high`. |
| `gpu` | bool | `false` | Filters to nodes reporting a GPU. |
| `volume` | name or `{name, path}` | — | Named volume. Anchors the service to one node. |
| `domain` | hostname | — | Public ingress. TLS is automatic. |
| `internal` | bool | `false` | Reachable only by other services on the same node. No published port, no hostname. |
| `health.path` | path | `/` | Must start with `/`. |
| `health.interval` | duration | `15s` | How often the container is probed. |
| `health.timeout` | duration | `5s` | How long one probe may take. |
| `health.disabled` | bool | `false` | For images with no shell to probe with. |
| `env` | map | `{}` | Plain values, committed to git. Use `secrets` for anything sensitive. |
| `secrets` | list | `[]` | Names resolved from the fleet secret store. Values never appear in this file. |
| `replicas` | int | `1` | Spread across distinct nodes where possible. |
| `affinity` | list | `[]` | Services to co-locate with. |
| `anti_affinity` | list | `[]` | Services to keep apart. |
| `reclaim` | enum | fleet default | `eager`, `idle`, `manual`. |

## Configuration and secrets

Both `env` and `secrets` become environment variables in the container, so both
must be legal variable names — `A-Z`, `0-9` and `_`, not starting with a digit.
A name in both is rejected rather than silently resolved, because the secret
would win and the file would be saying something untrue.

`env` holds values you are happy to commit. Anything else is a name in
`secrets`, and its value lives in the fleet store:

```bash
fleet secrets set DATABASE_URL          # prompts, echo off
pass show db/url | fleet secrets set DATABASE_URL   # or pipe it
fleet secrets ls
```

## Backups

A volume is the one thing Fleet cannot reproduce. An image rebuilds from a
commit and a container recreates from a manifest; the bytes in a database's
data directory exist on exactly one disk, in one machine.

```bash
fleet backup db          # copy its volume off the node holding it
fleet backups db         # what exists, newest first
```

The copy is made *by the node*, because only the node can read its own disk —
agents make outbound connections only, and the control plane never reaches into
one. So a backup is a job: the row is created immediately, the node performs it
on its next poll, and the archive is uploaded afterwards. Attempts that failed
stay in the list, because "the last three backups failed" is what you need to
know when you come looking.

Nothing runs inside the container that reads the volume. Docker will copy a
path out of a container that was only ever *created*, so the volume is mounted
read-only into a created container, its contents are read out, and it is
removed — no shell, no tar binary, and nothing that can misbehave while a
database is live on the other side of the same volume. The image used is the
one the service already runs, so a backup never waits on a pull.

### Restoring

```bash
fleet restore db            # the most recent backup
fleet restore db a1b2c3d4   # a specific one, by id prefix
```

**The service must be stopped.** Writing a data directory underneath a process
that is using it produces a volume that is neither the old state nor the new
one, and the corruption surfaces much later as unreadable pages rather than as
an error anyone connects to the restore. There is no way to do it safely while
it runs, so the API refuses rather than trying.

Extraction merges: files in the volume that are absent from the archive
survive. Clearing first would need a shell running over a data directory, which
is a far worse risk than a stale file — restore into a fresh volume when that
matters, by giving it a new name in the manifest.

### On a schedule

```yaml
databases:
  main:
    engine: postgres@16
    node: kakashi
    backup: daily          # hourly · daily · weekly
```

A backup you have to remember to take is one that gets taken twice and then
forgotten, which is the same as none on the day it matters. Due is measured
from the last *attempt*, not the last success — measuring from success retries
a failing volume on every sweep, which turns one broken volume into a loop of
tar processes on a machine that is also serving. The seven most recent complete
backups are kept; failures never evict a good archive.

A service with no volume has nothing to back up, and says so rather than
producing an archive of an empty directory and implying a safety it does not
provide.

One backup of a service runs at a time. A backup whose node stops reporting is
failed after thirty minutes rather than left `running` forever — that would
block every later backup of the same service, which presents as backups
quietly ceasing to work.

## Replicas

```yaml
services:
  web:
    build: .
    replicas: 3
```

Fleet keeps three copies running, each on a different node, and the hostname
load-balances across them. Losing a node costs you one copy rather than the
service.

The count is *reconciled*, not applied once at deploy time: if a replica dies
or its node disappears, the next sweep places a replacement. A new copy runs
the same image the others are running — never a fresh build, which could
produce a different artifact from the one already serving.

Two kinds of service are deliberately not scaled, and say so rather than
failing later:

- **A service with a `volume`.** Two processes writing one data directory
  corrupt it. It runs as a single copy.
- **A `pinned` service.** Pinning names one node, so there is nowhere to spread
  to. Use `flexible` or `preferred`.

Replicas are capped by the number of eligible nodes. Asking for more copies
than the fleet has machines places what it can and reports the shortfall —
three containers on one machine is not redundancy, because losing that machine
still loses the service.

## Databases

Declaring Postgres by hand means getting six things right at once: the image
and tag, a volume mounted at the engine's own data directory, `PGDATA` pointed
at a *subdirectory* because Postgres refuses to initialise into a mount
containing a `lost+found`, `internal: true` so the port is not published on the
node's LAN interface, a pin to the node holding the volume, and two secrets
whose values must match exactly. Each has a failure that only appears minutes
later somewhere else.

Two facts actually differ between deployments. Say those:

```yaml
fleet: homelab

databases:
  main:
    engine: postgres@16
    node: kakashi
  cache:
    engine: redis
    node: kakashi

services:
  api:
    build: ./api
    uses: [main, cache]
```

Fleet derives the rest. `main` becomes an internal service pinned to `kakashi`
with a volume at `/var/lib/postgresql/data`, `PGDATA` in its own subdirectory,
no health check (the prober speaks HTTP and Postgres does not), and a generated
password stored encrypted as `MAIN_PASSWORD`.

`uses:` gives the dependent service its connection details and pins it to the
same node — services resolve each other by name on that node's Docker network,
and that network does not span machines, so anywhere else the hostname simply
does not resolve.

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | `postgres://postgres:‹password›@main:5432/main` |
| `DATABASE_HOST` | `main` |
| `DATABASE_PORT` | `5432` |
| `DATABASE_NAME` | `main` |
| `DATABASE_USER` · `DATABASE_PASSWORD` | the generated credential |

The first database gets the unprefixed `DATABASE_*` names every framework
already looks for; any others are named after themselves (`CACHE_URL`). A value
you write yourself is never overwritten.

Engines: `postgres`, `mysql`, `mariadb`, `mongo`, `redis`. A bare name takes a
sensible default version; `postgres@16` pins one. Optional keys are `database`,
`user`, and `resources`.

Redis is deliberately given no password: the stock image does not enforce one,
and generating a credential the server ignores would misrepresent how protected
it is. It stays internal instead.

### The password is generated once

It is created on the first apply that declares the database and never
regenerated, because the engine writes it into its data directory at
initialisation — changing it later locks the application out of a database that
is working perfectly. It is generated rather than requested because the value
must be byte-identical in two places, and a person typing it twice is exactly
how those two drift apart.

### Composing a secret into a value

`${secret:NAME}` interpolates a stored secret into a plain `env` value. This is
how a connection string carries a password without the password being written
into the manifest or duplicated into a second secret:

```yaml
env:
  SENTRY_DSN: https://${secret:SENTRY_KEY}@o0.ingest.sentry.io/0
```

The reference is resolved only in the desired state sent to the agent that runs
the container. An unresolved one is reported and left as written — substituting
an empty string would produce a URL that looks plausible and fails to
authenticate somewhere far away.

## Secrets

When the values already exist in a `.env`, import them instead of retyping:

```bash
fleet secrets import PlasticWorld/.env --dry-run   # shows keys, never values
fleet secrets import PlasticWorld/.env
```

By default it stores only the keys this `fleet.yaml` names in a `secrets:`
list, and leaves the rest of the file alone — a `.env` is half configuration
and half credentials, and the manifest already draws that line. `--all` sends
every key, `--only A,B` names them explicitly, and a secret the manifest
declares but the file does not contain is reported before the deploy fails for
it later.

The parser errs towards refusing rather than guessing: an unterminated quote is
skipped with its line number, a duplicated key warns, and an unquoted value
containing `" #"` is stored whole rather than truncated at what might be a
comment — a password silently cut short fails authentication somewhere with
nothing pointing back at the file.

The value is never accepted as a command argument — that would put it in your
shell history and in `ps` output — and there is no command that prints one
back. Values are sealed with per-secret keys wrapped by the control plane's
master key, and the only place one is ever decrypted is the desired state sent
to the agent that runs the container.

Secrets are **fleet-scoped**, so one `POSTGRES_PASSWORD` serves both the
database that sets it and the app that connects with it. `--service <name>`
stores an override for a single service, which wins over the fleet value.

Deploying a service whose secrets are not set fails before anything is built,
naming what is missing. Changing a value takes effect on the next deploy;
already-running containers keep the environment they started with.

## Talking to another service

Every container the agent starts joins a user-defined Docker network called
`fleet` and answers to its own service name. So `web` reaches the database at
`postgres:5432` — a name, not an address that changes on every restart.

```yaml
services:
  postgres:
    image: postgres:16-alpine
    internal: true              # no published port, no public hostname
    secrets: [POSTGRES_PASSWORD]

  web:
    build: .
    domain: app.example.com
    affinity: [postgres]        # keeps them on one node, so the name resolves
    env:
      DATABASE_HOST: postgres
    secrets: [POSTGRES_PASSWORD]
```

`internal: true` is what a database wants: no host port is published, so it is
not reachable from the rest of your network, and no managed hostname is issued,
so ingress has nothing to route. Setting `internal` and `domain` together is an
error rather than a precedence rule — they say opposite things.

**Names resolve between services on the same node.** Nothing resolves across
machines until the mesh in [ADR 0001](adr/0001-mesh-and-ingress.md) lands, so a
service that depends on another needs `affinity` to keep the two together. When
an `env` value names another service in the manifest and no affinity is
declared, `fleet validate` warns — a dependency the scheduler is free to split
would otherwise fail at runtime, a long way from the file that caused it.

## Volumes and health

A volume mounts at `/data` unless you say otherwise. Most images are happy with
that; a database is not, because it keeps its data where it keeps it:

```yaml
volume: pgdata                                        # mounts at /data
volume: { name: pgdata, path: /var/lib/postgresql/data }   # mounts where Postgres looks
```

Getting this wrong is quiet rather than loud — the volume is attached, the
container starts, and the data goes into the image layer instead, where the
next deploy discards it.

Health checks probe the container's own port over HTTP, trying `wget` and then
`curl`. An image carrying neither cannot be probed this way, and a check that
can never pass is worse than none, so those set `health: { disabled: true }`.

### Quantities

`512Mi`, `2Gi`, `1G`, or a bare number meaning megabytes. Binary units are
powers of 1024; decimal units are powers of 1000. Anything else is rejected
rather than guessed at.

`resources.ram` is both a placement constraint and the container's memory
limit. A service that exceeds it is stopped by the kernel rather than being
allowed to take the node down with it.

### Durations

`5s`, `500ms`, `1m`, `2h`, or a bare number meaning seconds. Rounded up to the
nearest second, since a timeout that rounded to zero would mean no timeout.

## Placement

- **flexible** — the scheduler may place and move this service. Correct for
  anything stateless.
- **preferred** — starts on `node`, may be moved on failure, returns when the
  node is healthy again if `reclaim` allows.
- **pinned** — runs only on `node`. On failure it raises a distinct
  pinned-service alert and stays down until that node returns. It is never
  relocated automatically.

A service with a `volume` is anchored to the node holding that volume whatever
`placement` says, because data does not move between machines. Declaring it
`pinned` is clearer for whoever reads the file next, and the validator warns
when you do not.

## Warnings

These are allowed but never silent:

- a `volume` on a `flexible` service
- `replicas` above 1 sharing one `volume`
- `gpu: true` with no `arch` named

## Errors

Every problem in the file is reported at once, each naming the fix:

```
services.web       placement "pinned" requires "node" naming which node to pin to
services.api       set "build" or "image", not both — they mean different things
services.cache     "sessions" is not a service in this manifest
services.worker    "loads" is not a valid size. Use 512Mi, 2Gi, or a plain
                   number of megabytes.
```
