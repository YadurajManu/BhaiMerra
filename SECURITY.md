# Security policy

Fleet OS asks for a lot of trust: your machines, your registry credentials, and
eventually your users' data. Please report anything that undermines that.

## Reporting a vulnerability

**Do not open a public issue.**

Send details to **security@fleet-os.dev**, or use GitHub's
[private vulnerability reporting](https://github.com/YadurajManu/fleet-os/security/advisories/new)
on this repository.

Useful to include, as far as you have it:

- What an attacker can do, and what access they need to start.
- Steps to reproduce, or a proof of concept.
- The affected component — control plane, agent, CLI, dashboard — and version
  or commit.

## What to expect

| | |
| --- | --- |
| Acknowledgement | Within one business day. |
| Assessment | Within five business days, including whether it is in scope and how it is rated. |
| Fix or mitigation | Within fourteen days for anything exploitable. Longer only if I say so, with a reason. |
| Credit | Named in the advisory and the changelog, unless you would rather not be. |

Fleet OS is maintained by one person, so those are honest targets rather than a
contractual SLA. If something is being actively exploited, say so in the
subject line and I will treat it as such.

## Safe harbour

I will not pursue or support legal action against good-faith research that:

- avoids privacy violations, data destruction, and degradation of anyone's
  service;
- stays within systems you own, or a self-hosted install you control;
- gives me a reasonable chance to fix the issue before it is made public.

Please do not test against `fleetapi.plastikworld.xyz` or any other hosted
instance you do not own. The control plane is a Docker Compose file — stand up
your own and attack that. [Self-hosting](docs/self-hosting.md) has the steps.

## Supported versions

Fleet OS is pre-1.0 and moves quickly. Security fixes land on `main` and in the
next release of the affected component; there are no long-lived maintenance
branches yet.

## Known design boundaries

These are deliberate, documented properties rather than vulnerabilities — but
if you can break one of them, that *is* a vulnerability and I want to hear:

- **Agents are outbound-only.** The control plane never opens a connection to a
  node. A path that lets it do so is a bug.
- **An installation belongs to exactly one organisation.** GitHub App
  installations are global to the App; Fleet scopes them per organisation. Any
  route that lets one tenant reach another's repositories is critical.
- **Secrets are envelope-encrypted** with a per-secret key and injected only
  into services that declare them. A secret readable by a service that did not
  declare it, or by another fleet, is critical.
- **A node's Docker socket is reachable by the agent alone.** The agent runs
  with the privileges you give it; anything that turns a deploy into arbitrary
  code execution on a node *outside* the container it declared is critical.
