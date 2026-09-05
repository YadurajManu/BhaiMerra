# A manifest written from reality, not from guesses

**Status:** proposal, for discussion. Nothing here is built.
**Date:** 2026-09-05

## The observation this starts from

`fleet init --ai` ran on MedLifeCycle today and reported **"reviewed — nothing
to change."** Here is part of what it left behind:

```yaml
  backend:
    container_port: 3100
    resources: { ram: 512Mi, cpu: 0.5 }
    # No health check: container state decides whether this
    # is up. Add one once you know a path that returns 2xx —
    #   health: { path: /healthz }
```

Two things in that block are wrong, and the reviewer could not have known
either of them:

| What the manifest says | What the running fleet says |
| --- | --- |
| `ram: 512Mi` | the container's steady state is **59.73 MB** — 12% of the reservation |
| "Add one once you know a path that returns 2xx" | `/`, `/health` and `/healthz` all return **404**; the app serves under a prefix |

The second one cost real money today. An earlier version of this manifest had
`health_check_path = /` stored against the service, so the agent probed `/`,
got 404, reported the container unhealthy for ever, and the control plane would
not promote it. Every deploy sat unconfirmed for exactly 600 seconds until the
rollout fallback promoted it anyway. The container had been serving since ten
seconds in.

The parser bug behind that is fixed (`37dca56`). The *class* of problem is not.

## The claim

**A repository cannot answer the questions a manifest asks.** How much memory
does this need? Which path returns 2xx? How long does it take to start? None of
that is in the source. It is a property of the program running on a machine.

Fleet OS is unusual in that it *owns the machine*. The agent already reports,
every five seconds, the memory each container is using, whether it is running,
and what it printed. That is a strictly better source of truth than any amount
of reading, and today it is used only to draw a dashboard.

Three proposals, in the order I would build them.

---

## 1. Determine the health path instead of leaving a TODO

**The smallest change with the largest return, and it needs no model at all.**

After a service's first successful deploy, the agent has a running container on
a known host port. Probe a short list of candidates from the node —
`/health`, `/healthz`, `/api/health`, `/_health`, `/status`, `/` — and record
which ones answered 2xx.

Then one of two things is true, and both are useful:

- **Something answered.** Offer to write it into the manifest. The comment
  `init` writes today — *"Add one once you know a path that returns 2xx"* — is
  a research task handed to a human. This does the research.
- **Nothing answered.** That is the finding. Say so, and leave the health check
  off, which is now the correct and explicit default.

Why this first: it is cheap, it is deterministic, it costs nothing against the
AI budget, and it closes the exact hole that produced today's ten-minute
deploys. It also makes `init`'s generated comment honest — right now the
generator is admitting ignorance about something the system could simply find
out.

**Cost:** an agent-side probe list, one field on the deploy result, one prompt
in the CLI. No new AI surface.

---

## 2. `fleet tune` — resources from measurement

Every service in this fleet reserves `512Mi`. Measured steady state:

```
fleet-db-0d53991c        19.98 MB / 512 MB     3.9%
fleet-backend-1d36b22b   59.73 MB / 512 MB    11.67%
```

The scheduler plans capacity around the reservation, not the reality. On a
one-node fleet that is invisible. On a fleet where it matters, it is the
difference between a service fitting and `no_eligible_node` — a failure whose
cause would then be a number `init` guessed weeks earlier.

`fleet tune` reads N days of heartbeat samples and proposes edits: a
reservation with real headroom over the observed peak, not a round number
somebody's generator picked. It reuses `applyEdits` and its existing
`FORBIDDEN` list, so a tune can never touch `node`, `build`, `image`, `uses`,
or `volume` — the fields no measurement should be allowed to decide.

Crucially it **proposes**; a person applies. The observed peak of a service
that has never seen load is not a safe reservation, and the tool should say
that rather than pretend otherwise.

Why this is worth building: nothing else can do it. A generic manifest linter
reads files. Fleet watched the program run.

**Cost:** a query over heartbeat history, a percentile, and a reuse of the
edits machinery that already exists.

---

## 3. Let `diagnose` propose the fix

`fleet diagnose` currently ends in prose:

> Inspect the backend's internal health endpoint to determine why it reports
> unhealthy.

It is right, and it still leaves the work to the reader. It already has
`applyEdits` next door, with a guardrail list written precisely for
model-proposed changes. The last step of an investigation could be a concrete
diff:

```
  proposed  backend.health → null
      why   every candidate path returns 404; container state is the only
            evidence available for this service
    apply?  [y/N]
```

Read-only investigation, proposed edit, human applies. The tools stay read-only
— that property is what makes the loop safe to run against a live fleet, and it
should not change. What changes is that the output is actionable rather than
advisory.

**Cost:** a fourth reply shape in the diagnose protocol, and a confirm prompt.

---

## What I would not build

**Auto-apply.** Every one of these proposals is a system inferring something
about a machine, and this session's whole lesson is that inference leaving the
repository needs enforcement, not trust. The review invented a node once. It
replaced a `build:` with `image: nginx:alpine` and served nginx's welcome page
over somebody's site. Guardrails caught both. A human in the loop is the third
guardrail and the cheapest one.

**A bigger model.** None of the three problems above is a reasoning problem.
They are all "nobody asked the machine."

## Open question for discussion

Proposals 1 and 2 both want the same thing: a place where Fleet writes back to
`fleet.yaml` after learning something. Should that be one command
(`fleet tune`, covering resources *and* health), or should the health probe
happen automatically as part of the first deploy and only resources need a
command?

I lean toward: **health is automatic and offered at deploy time** (you are
already watching that deploy, and the answer is fresh), **resources are a
separate command** (they need days of data, and there is nothing to decide on
day one).
