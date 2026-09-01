# Contributing to Fleet OS

Bug reports, design arguments and pull requests are all welcome. This file is
short because most of what you need is in the code and the commit log.

One thing worth knowing up front: Fleet OS is maintained by one person. That
means a pull request may sit for a few days, and it means a well-written issue
is often worth more than a patch — a reproduction I can run is the expensive
part, not the fix.

## Repository layout

| Directory | What lives there |
| --- | --- |
| `control-plane/` | TypeScript API, scheduler, builds, ingress, migrations. Fastify + Drizzle + Postgres + Redis. |
| `agent/` | The Go agent. One static binary per node; speaks the Docker Engine API directly. |
| `cli/` | The `fleet` command, published to npm as `@yadurajfleetos/cli`. |
| `dashboard/` | React 19 dashboard, served by nginx. |
| `www/` | The marketing site and documentation (Vite). |
| `deploy/` | Docker Compose, Cloudflare Tunnel config, registry auth. |
| `docs/` | Architecture, data model, `fleet.yaml` spec, self-hosting. |

## Getting the tests running

The control-plane tests need a real Postgres and a real Redis. They are not
mocked, because the bugs worth catching there are the ones that only appear
against an actual database.

```bash
git clone https://github.com/YadurajManu/fleet-os.git && cd fleet-os

# control plane — needs Postgres + Redis reachable
cd control-plane && npm ci && npm run typecheck && npm test

# CLI
cd ../cli && npm ci && npm test

# dashboard (build is the check)
cd ../dashboard && npm ci && npm run build

# agent
cd ../agent && go test ./...
```

`.github/workflows/ci.yml` is the authoritative description of the environment
those tests expect. Copying `control-plane/.env.example` to `.env.test` is the
local equivalent.

If a test needs configuration, put that configuration **in the test file**, not
in a gitignored dotfile. A test that only passes on the author's machine is
worse than no test.

## Commit messages

The house style is: say what behaviour changed, and why the old behaviour was
wrong. `git log` is the reference. A subject line reads as a statement about
the software, not a summary of the diff:

```
fix(build): a failed cache upload must not discard a pushed image
feat(cli): import secrets from a .env instead of retyping them
fix(fleet-up): a registry that asks for credentials is a working registry
```

Not `fix bug`, not `update build.ts`. If you cannot say what was wrong before,
the change probably needs another look.

## Pull requests

- Keep it to one behaviour change. Two unrelated fixes are two pull requests.
- Add a test that fails without your change. For a bug, that test is the
  reproduction.
- Run the suite for whatever you touched — CI runs all of them, but finding it
  locally is faster for both of us.
- Comments explain *why*, not *what*. The code already says what.

## Reporting bugs

Open an issue with the template. The three things that decide whether a bug
gets fixed quickly:

1. What you expected, and what happened instead.
2. Enough to reproduce it — a `fleet.yaml`, the command, the node's OS and
   architecture.
3. Any error output, in full. Fleet's errors are written to be actionable; if
   one was not, that is itself a bug worth reporting.

Never paste secrets, tokens or `flp_` pairing tokens into an issue.

## Security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).
