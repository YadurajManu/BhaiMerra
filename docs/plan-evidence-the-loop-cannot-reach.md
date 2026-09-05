# Evidence the loop cannot reach

**Status:** proposal, for discussion. Nothing here is built.
**Date:** 2026-09-05
**Follows:** [plan-manifest-from-reality.md](plan-manifest-from-reality.md), whose
items 1 and 2 shipped as health-path discovery and `fleet tune`.

Two proposals. The first closes a hole that cost real time today; the second
turns three separate answers into one.

---

## 1. A `context` lookup — what the builder actually received

### What happened

Docker's example voting app, six services. Five deployed. The .NET `worker`
failed every build:

```
> [build 5/7] RUN dotnet restore -a arm64
MSBUILD : error MSB1011: Specify which project or solution file to use
because this folder contains more than one project or solution file.
```

The worker directory contains exactly one project file.

`fleet diagnose "hey"` reached the right conclusion in 2.6 seconds and two
lookups, and named `Dockerfile:19`. Its next step was *"inspect the worker's
Dockerfile and the source directory"*. The source directory was innocent.

The cause was `._Worker.csproj`, an AppleDouble file that existed **only inside
the uploaded build context** — created by macOS `bsdtar`, invisible to macOS
`tar tzf`, and materialised as a real file by GNU `tar` on the control plane.
Docker's `COPY *.csproj .` matched it because Go's `filepath.Match` counts a
leading dot where a shell does not.

Finding that took roughly ten tool calls, one hypothesis asserted and retracted,
and a pack-here/extract-there experiment across two machines. Nothing in the
loop could have found it, because every lookup it has reads the database or the
node, and this file was in neither.

### Why this is the biggest remaining gap

Build failures are a large share of real failures, and they are the one class
where the evidence lives somewhere no existing lookup reaches. The loop can
read a failure reason that says *what* buildx refused to do, and can never see
*what it was given to work with*.

### The design, which the code has already half-written

`uploadContext` in `control-plane/src/build/context.ts` already produces a
complete file listing:

```ts
const listing = await runTar(['-tzf', '-'], undefined, archive)
```

It walks that listing to reject absolute paths and `..` escapes, and to check a
Dockerfile is present — and then throws it away.

That listing is exactly the missing evidence, and it is already computed.

**Keep the listing, not the files.** The context itself is deleted on both the
success and failure paths, deliberately: *"customer source is held only for as
long as it takes to build it, and a control plane that keeps every upload fills
its disk in a week."* That property must not change. A listing is file names and
sizes — no source at all — measured in kilobytes, and it answers the question
completely.

Concretely:

- `deployments.buildContext jsonb` — `{ files: [{path, bytes}], totalBytes }`,
  capped at some sane number of entries with a count of the remainder.
- Written when the context is uploaded, alongside the existing safety walk.
- A `context {service}` lookup returning it, ordered so oddities are visible:
  dotfiles and AppleDouble members first, then the rest.
- The `diagnose` prompt learns one line: for a failed build, ask what the
  builder received before theorising about the Dockerfile.

On the worker, the first call would have returned `._Worker.csproj` beside
`Worker.csproj`, and the investigation would have been one step long.

### Cost

One column, one write on a path that already parses the listing, one lookup, one
prompt line. No new AI surface, no retained source, nothing on the hot path.

### The related change

**`fleet explain` has no tools at all.** It reads a log the user already has,
and reasons about the text. `diagnose` goes and finds things. Explain is
diagnose with the question pre-filled — *"why did this deployment fail?"* — and
keeping them separate means the better machinery is unavailable exactly where
failures are most common.

Worth folding explain into the loop once `context` exists, rather than before:
the merge is only clearly an improvement when the loop can see build evidence,
which is most of what explain is asked about.

---

## 2. Review the manifest against measured facts

### What happened

`fleet init --ai` on the voting app reported:

```
✔ reviewed  nothing to change
```

about a manifest with no health check on any service and `ram: 512Mi` guessed
for all six. It was not wrong. Nothing in a repository says which path returns
2xx or how much memory a program needs — both are properties of the program
running, which is why health discovery and `fleet tune` exist.

But Fleet now knows both, after a deploy. The review is still reading only the
repository.

### The proposal

A review pass that runs against a **deployed** project and reads measured
evidence instead of source: the discovered health path, the observed memory
peak, the placement the scheduler actually chose, the failures since.

This is a genuinely different review, not the same one run twice. The first is
"what does this repository suggest"; the second is "what has this thing done".
Only the second can produce a correct manifest.

It also unifies three answers that are currently three commands. Today, "is my
manifest right?" is answered partly by `init --ai` (source), partly by `doctor`
(health paths), and partly by `tune` (memory) — three outputs, none complete.
One pass that reads all the measured evidence is the whole answer.

Reuses `applyEdits` and its existing `FORBIDDEN` list, so a review still cannot
touch `node`, `build`, `image`, `uses`, `volume`, or `name`.

### The honesty fix that goes with it

`nothing to change` is printed whenever `changed === false`. It cannot
distinguish:

- *I read the evidence, and the manifest is correct*
- *I could not determine anything, so I changed nothing*

Those are opposite meanings sharing one line, and today's run was the second
presented as the first. This is the same bug as `null` versus `[]` in health
discovery — "we have not looked" and "we looked and found nothing" must not
print identically — and it was worth fixing there for the same reason.

### Dependency

Needs agent 0.2.4 on the nodes and a day of heartbeats, or there is no measured
evidence to review against. Until then this pass has the same problem as the one
it replaces.

---

## Order, and why

**1 first.** It is smaller, it needs no AI budget, it retains no customer source,
and today produced direct evidence for it twice — once where `diagnose` hit the
wall, and once where I did. It also makes the explain/diagnose merge worth doing.

**2 second**, once 0.2.4 has landed and there is something measured to read. Built
before that, it would review the same guesses it reviewed the first time.

## What neither should do

**Apply anything automatically.** Every proposal here is the system inferring
something about a machine from evidence. The review has already, in this
project, invented a node from a compose service name and replaced a `build:`
with `image: nginx:alpine` — serving nginx's welcome page over a real site.
Guardrails caught both. A person reading a diff is the third guardrail and the
cheapest one.

## Open question

The `context` listing is per-deployment, but it is really per-upload — several
deployments can share one context, and a service redeployed unchanged uploads
the same bytes again. Storing it on the deployment is simplest and duplicates a
few kilobytes; storing it on a context table is tidier and adds a join and a
lifecycle. I lean to the deployment row: the question is always asked about a
deployment, and a few kilobytes per deploy is cheaper than a table nobody else
queries.
