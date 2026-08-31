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
| `resources.ram` | quantity | `256Mi` | Hard constraint during filtering. |
| `resources.cpu` | number | `0.25` | Used for ranking, not enforced as a cap. |
| `arch` | list | all | `arm64`, `armv7`, `amd64`. Empty means any. |
| `min_reliability` | enum | `any` | `any`, `opportunistic`, `standard`, `high`. |
| `gpu` | bool | `false` | Filters to nodes reporting a GPU. |
| `volume` | name | — | Named volume. Anchors the service to one node. |
| `domain` | hostname | — | Public ingress. TLS is automatic. |
| `health.path` | path | `/` | Must start with `/`. |
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

### Quantities

`512Mi`, `2Gi`, `1G`, or a bare number meaning megabytes. Binary units are
powers of 1024; decimal units are powers of 1000. Anything else is rejected
rather than guessed at.

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
