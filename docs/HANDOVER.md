# Fleet OS — handover

Written 2026-09-05 for whoever picks this up next, human or otherwise.

This is not a tour of the codebase; the code has comments and they are worth
reading. This is the part that is not in the code: what was built recently and
why, the rules that decisions were made against, and the traps that cost hours
so they do not cost them again.

---

## 1. What Fleet OS is

A self-hosted deployment orchestrator. You point it at machines you own, it
schedules containers onto them, and it routes public traffic to them.

| Piece | Language | Job |
| --- | --- | --- |
| `control-plane/` | TypeScript, Fastify 5, Drizzle, Postgres 16, Redis | schedules, builds images, holds all state |
| `agent/` | Go 1.24 | runs on each node, reconciles desired state, reports heartbeats |
| `cli/` | TypeScript | `fleet` — the primary interface |
| `dashboard/` | React 19 | the web view |

**Agents are outbound-only.** A node never accepts an inbound connection: it
registers, heartbeats every five seconds, polls desired state, and opens a
reverse WebSocket tunnel. Every design decision that looks strange is usually
downstream of this — logs are read from the last heartbeat rather than fetched,
health is probed by the agent rather than by the control plane, and anything
the control plane wants to know about a node must arrive in a heartbeat.

The live deployment: control plane on AWS Lightsail behind Cloudflare
(`fleetapi.plastikworld.xyz`), reached over SSH as `fleet-cp` through a
Cloudflare Access tunnel. One node, an Apple Silicon Mac, named
`sayyestoheaven`.

---

## 2. What was built in this session

Roughly a day's work, 24 commits, almost all of it the **diagnosis layer** —
the part of Fleet that answers "why is this broken?"

### `fleet diagnose "<question>"`

An agentic loop. The model is given a question and a set of **read-only**
lookups, and answers with findings that each cite the lookup that supports them.

The lookups: `services`, `deployments`, `nodes`, `containers`, `logs`,
`history`, `context`, `placements`, `probe`. All fleet-scoped at the boundary,
so no argument-shaping reaches another fleet's data.

Two of those were added because an investigation demonstrably could not finish
without them:

- **`history`** — the audit log. A diagnosis said, with citations and in the
  present tense, that the scheduler had nowhere to put a service. Someone had
  stopped it from the dashboard thirty minutes earlier. Stopping a service
  leaves no failure, no placement event and no container, so nothing it could
  see recorded the most likely cause of a service being down.
- **`context`** — the listing of files the builder was given. A .NET build
  failed on "more than one project or solution file" against a directory
  holding exactly one; the second was `._Worker.csproj`, which existed only
  inside the uploaded archive. Every other lookup reads the database or a node,
  and that file was in neither.

### `fleet explain <service>`

The same loop with the question pre-filled. It used to be a separate,
tool-less thing that read a log and reasoned about the text — fine for a buildx
error that explains itself, useless for the failures that do not. It keeps its
own cache and daily limit, which the loop has no opinion about.

### `fleet fix <service>`

Diagnose → propose one manifest change → **ask** → apply to local `fleet.yaml`
→ redeploy → follow to a conclusion → put the manifest back if the service was
running before and did not come back.

### `fleet tune`

Compares each service's memory reservation against what it actually used.
Refuses to advise until a service has been watched for 24 hours.

### Health path discovery

`fleet init` used to write "Add one once you know a path that returns 2xx" into
every manifest — a research task handed to the reader about a program the node
is already running. The agent now sweeps candidate paths after a deploy and
`fleet doctor` reports what answered.

---

## 3. The principles

These are not style preferences. Each one is here because violating it cost
real time, and most of them were learned the hard way in the last two days.

### The model reads a repository well and reasons badly about the machines it will run on

This is the single most load-bearing observation in the project. Every AI
feature here is built around it.

A review of a repository invented a node called `mongo` from a compose service
name — no such machine existed. Another replaced a service's `build:` with
`image: nginx:alpine` and served nginx's welcome page over a real site. Both
were confident, both were plausible from the source alone, and both were caught
only by a guardrail.

**Every inference leaving the repository needs enforcement, not instruction.**
Telling a model not to do something is not a control. `applyEdits` has an
`EDITABLE` allowlist and a `FORBIDDEN` denylist, and the denylist is enforced
server-side before the CLI is offered anything to confirm.

### Constrain, don't ask

Every model tried reaches for its own tool-calling syntax when a prompt
describes lookups. Groq refused a request outright — *"Tool choice is none, but
model called a tool"*. A local Gemma answered
`<|tool_call>call:services{}<tool_call|>`. No amount of "do not use function
calling" moved either.

Both produce exactly the right object when handed a JSON schema. The prompt
asks; `response_format: json_schema` decides. Prompt wording is a hint, a
schema is a mechanism — prefer the mechanism, and keep the wording as well
because it still helps.

### "We have not looked" and "we looked and found nothing" must never print the same

`discovered_health` is `null` when nothing has swept, and `[]` when every
candidate was tried and none answered. The second is a *finding* — it is true
of a backend serving under a route prefix, and it is what a manifest should
record instead of guessing at `/`.

The same bug exists elsewhere and is worth hunting: `fleet init --ai` prints
`nothing to change` both when it read the evidence and found the manifest
correct, and when it could determine nothing at all. Those are opposite
meanings sharing one line.

### A refusal is an answer

When `fleet fix` finds that the correct change is a rename, it says so in words
and declines to perform it. When `fleet tune` has four minutes of data, it says
so rather than advising from it. When the loop cannot establish a cause, it
says what it did establish.

A tool that always produces something produces confident nonsense at the
margins, and one confident wrong answer costs more trust than ten honest
refusals.

### Guardrails are not confirmations

`--yes` waives the question. It does not waive the refusals — those are decided
server-side, before the CLI has anything to offer. A person clicking through a
prompt is not a guardrail; not offering the button is.

### Verification follows to a conclusion

A deploy request returns when a node has been chosen. The container starting is
the agent's job, afterwards. So reading the status immediately finds
`deploying` and calls it success — a verification step that verifies nothing.
`fleet fix` uses `awaitRunning`.

### Bound by every dimension that can run out

An investigation is bounded by steps (`MAX_CALLS`), by wall clock
(`DEADLINE_MS`), and each individual call is bounded by whatever remains of the
deadline. Missing the third produced a 524 from a loop that was "bounded" at 85
seconds: 84 seconds elapsed plus one 26-second call is 110, and Cloudflare
closes at about 100.

And **tell the agent its budget**. A model that does not know it has one step
left cannot spend it — a real run made eight individually reasonable lookups
and never stopped to answer.

### Judge a change against where it started

`fleet fix` reverts only when a service *was running* and did not come back. One
that was already down and is still down has not been made worse, and reverting
there removes a change that may well be right while leaving the real problem in
place.

### Comments say why, and name the incident

The convention throughout: a comment explains the decision and the failure that
caused it, in prose, at whatever length that takes. `agent/internal/health/`,
`control-plane/src/ai/`, and `control-plane/src/heartbeat/sweeper.ts` are the
best examples. Match this. A reader who knows *why* can change the code safely;
one who only knows *what* cannot.

### A test that passes without the fix is not a test

Every non-trivial fix here was verified by breaking it again and watching the
test fail. Two examples worth copying:

- The AppleDouble test parses tar members from raw bytes rather than shelling
  out to `tar tzf`, because on macOS that command **cannot see** the thing
  being asserted about.
- The `no_eligible_node` prefix test pins two files that must agree; they are
  written apart, and if they drift every flexible service stays stranded
  silently.

---

## 4. Traps, and the hours they cost

**`npm version` does not commit or tag here.** It is run in `cli/` and npm
looks for a `.git` beside `package.json`; this repo's is one level up. Three
releases in a row left their version bump uncommitted. Bump, then commit and
tag by hand.

**`drizzle-kit generate` produces a wrong migration.** Snapshots in
`control-plane/src/db/migrations/meta/` only go to `0002`, so it diffs against a
16-version-old baseline and emits `CREATE TABLE` for tables that exist. That
migration would fail on the live database. **Hand-write migrations**, matching
`0003`–`0021`, and append the journal entry manually.

**macOS `tar` smuggles AppleDouble files into archives, invisibly.** `tar tzf`
on macOS does not list them — bsdtar folds them back into xattrs — so an archive
looks correct on the machine that made it and is not. GNU tar on Linux writes
them out as real files. `--no-xattrs` does *not* stop it; only
`COPYFILE_DISABLE=1` does. Docker's COPY globs match them because Go's
`filepath.Match` counts a leading dot where a shell does not.

**Cloudflare's free plan caps request bodies at 100MB and origin responses at
~100 seconds.** The registry bypasses it through Caddy on a grey-clouded record.
The diagnosis loop lives inside the 100s window on purpose.

**The test database needs Redis too.** `control-plane/.env.test` wants Postgres
on 55432 and Redis on 56379, both local containers. They stop when Docker does
and the schema needs re-applying:
`npx dotenv -e .env.test -- tsx src/db/migrate.ts`.

**The suite is 36 files run as 36 serial processes.** A cold single file costs
~2.4s of which ~50ms is tests. Serial is deliberate — the tests share one
database and the fixtures collide. Run the file that covers your change, not
`npm test`. `--test-isolation=none` is the safe speedup if anyone wants it.

**Fixtures must be unique per run.** The database is not reset between runs. A
hardcoded hostname passed exactly once and then hit
`services_hostname_key` for ever. Use a `runId`.

---

## 5. Operating it

**Deploy the control plane** — there is deliberately no deploy-on-push:

```bash
ssh fleet-cp 'cd /opt/fleet-os && sudo git pull --ff-only && sudo docker compose -f deploy/docker-compose.yml up -d --build control-plane'
```

Migrations run on boot and the process refuses to start if they fail.

**Release the agent** — the box has no Go, so binaries are cross-compiled
locally and uploaded to `/opt/fleet-os/agent/dist/`, which the control plane
serves at `/install/`. Agents poll `SHA256SUMS` every 30 minutes and self-verify
before staging. `agent/Makefile` has the `dist` target. **Use
`COPYFILE_DISABLE=1` when tarring the release**, for the reason above.

**AI configuration** lives in `/opt/fleet-os/deploy/.env`: `AI_BASE_URL`,
`AI_MODEL`, `AI_API_KEY`, `AI_DAILY_LIMIT`. Any OpenAI-compatible endpoint
works. The key is only ever on the server — the CLI never sees it, by design.

At handover the control plane points at a **local LM Studio** on the node's Mac,
reached through a Cloudflare tunnel and an authenticating proxy
(`~/.fleet-lm/`, two launchd agents). LM Studio has no auth of its own, so
nothing may ever point at its port directly. A Groq config is backed up beside
the `.env`.

---

## 6. What is not done

Ordered by how much they would repay.

**The loop cannot read source.** The largest remaining blind spot, and the same
shape as the two already closed. A service failed because `vote/app.py:21`
hardcodes `Redis(host="redis")` while the manifest names that database `cache`.
The loop correctly traced unhealthy → connection failure → "check the cache
service", and could go no further, because nothing it can call reads a
repository. A `source` lookup over the few files a service is built from would
close it.

**The manifest is never reviewed against measured facts.** `fleet init --ai`
reads only the repository, which is why it reported "nothing to change" about a
manifest with no health checks and `512Mi` guessed six times. Discovery and
`tune` now know the real answers. See
`docs/plan-evidence-the-loop-cannot-reach.md`.

**`fleet doctor` reports `disk 658% used`.** A percentage over 100 is arithmetic
that is wrong somewhere — probably used-versus-free, the same class of mistake
as an earlier Windows disk figure. Small, and it undermines confidence in every
other line of that report.

**The full control-plane suite has not been run green end to end recently.**
Affected files were run for each change (60 AI tests, 22 diagnose, 108 CLI). The
whole suite has not. Nobody should claim it is green until someone has watched
it be green.

**Two untracked files at the repo root**, `agent/Dockerfile` and `fleet.yaml`,
predate this session's work. Decide whether they belong.

---

## 7. If you change one thing, understand this first

The loop is safe to point at a live fleet because **its tools cannot act**.
Every failure worth diagnosing is one where the system already acted on a bad
inference; a diagnosis that could also act would be the same mistake with a
larger blast radius. `fleet fix` acts, and it is defensible only because every
step it takes is reversible and a person approves it.

If you make a lookup that writes, or let a refusal be waived by a flag, you have
removed the reason any of this is allowed to run.
