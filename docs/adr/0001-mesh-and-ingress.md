# ADR 0001 — Mesh networking and reaching nodes behind NAT

Status: **proposed**
Date: 20 August 2026
Context: `context.txt` §14 — "the single highest-leverage architecture
decision, to be resolved before Phase 4 begins"

## The reframe

The tech doc treats this as one decision. It is two, they have different
answers, and separating them is most of the value here.

**P1 — public traffic must reach a service on a node behind NAT.**
Today ingress dials the node's advertise address. That works on a LAN and
fails through NAT, which is every home. This blocks hosting the control
plane anywhere but your own network.

**P2 — services must reach each other by name across nodes** (PRD 7.4).
`postgres.homelab.internal` from a container on another machine.

P1 is what blocks shipping. P2 is what needs a mesh. Solving P2 to fix P1
is backwards, and it is the trap the original framing sets.

## P1 does not need a mesh

Invert the direction. The agent already holds an outbound connection to the
control plane for heartbeats, and outbound is exactly what NAT permits. Keep
a persistent stream open and multiplex proxied requests back down it — the
same shape as cloudflared or ngrok.

The control plane then never dials a node. It never needs a mesh address, a
public IP, or a hole punched. `advertiseAddr` stops being load-bearing.

Cost: every request for a service crosses the control plane. For a homelab
at hobby traffic that is fine, and it is the same path a Cloudflare Tunnel
takes today. It is not fine at scale, which is not v1.

## P2: the options

### A. tsnet against Tailscale's own coordination server

Fastest to working. But every Fleet OS user would need a Tailscale account,
and the product would depend on Tailscale Inc. For something whose pitch is
"stop renting someone else's cloud", making the network layer depend on
someone else's cloud is a contradiction the target audience will notice
immediately. It also cannot satisfy PRD 7.10 — a self-hoster cannot
self-host Tailscale's control plane.

**Rejected on positioning, not on merit.**

### B. tsnet against self-hosted Headscale

[Headscale](https://github.com/juanfont/headscale) reimplements the
coordination API; tsnet points at it with `ControlURL`. Fleet OS ships the
coordinator, so nothing leaves the user's control.

- The agent is already Go, so tsnet embeds directly: userspace WireGuard on
  a gVisor netstack, no daemon, no root, no kernel module. That matches the
  single-static-binary and <50MB constraints exactly.
- NAT traversal and DERP relays come for free. This is the part that is
  genuinely hard and the part Tailscale is genuinely excellent at.
- BSD-3-Clause on both sides, compatible with open-core.

Costs: one more service to run, and Headscale tracks the last ~10 Tailscale
client releases, so the agent's tsnet version is not free to drift.

### C. Bespoke WireGuard coordination

Full control, no third party. But WireGuard gives you an encrypted tunnel
between two endpoints that can already reach each other. It does not give
you discovery, key distribution, NAT hole punching, or a relay for the ~10%
of pairs where hole punching fails. Writing those is the work, and it is
months of it.

**Rejected.** Reinventing the one thing the alternative does best, on a
product whose actual differentiator is the scheduler.

## Decision

**B — tsnet with self-hosted Headscale — for P2. A reverse tunnel for P1.**

And the useful consequence: **the control plane never joins the mesh.**

Ingress rides the reverse tunnel. The mesh carries only node-to-node
traffic, where both ends are Go agents that embed tsnet natively. The
TypeScript control plane never needs to be a mesh peer, which removes the
whole language-boundary problem — no `tailscaled` sidecar in userspace mode,
no SOCKS5 proxying from Node, no Go edge binary to keep in sync.

That was the strongest argument against tsnet and the reframe dissolves it.

## Sequence

| | | Unblocks |
|---|---|---|
| **4a** | Reverse tunnel ingress: agent holds a stream, control plane multiplexes | Hosting anywhere, including Railway |
| **4b** | TLS at the edge via ACME | Real domains |
| **4c** | tsnet + Headscale, service discovery by name | Node-to-node traffic |

4a is the one that matters. 4c may not be v1 at all — see below.

## Open questions

1. **Is P2 in v1?** Most homelab services talk to a database and the
   internet, not to each other across machines. If service-to-service is
   rare, 4c could wait, and the mesh stops being a v1 blocker entirely.
   Worth checking against real usage before building it.
2. **Ship Headscale in the compose stack, or bring-your-own?** Bundling is
   friendlier; it also makes Fleet OS responsible for its upgrades.
3. **Relay bandwidth.** Traffic that cannot hole-punch goes through a DERP
   relay. Self-hosters run their own; the hosted product pays for it. That
   is a real cost line in PRD 7.10's pricing.

## Consequences

- `advertiseAddr` stops being required, and the "must be directly routable"
  caveat in the README goes away.
- The agent gains a persistent outbound stream. It must reconnect with
  backoff and must not drop running containers when the stream breaks —
  the same rule the heartbeat already follows.
- Every proxied request crosses the control plane, so the edge becomes
  bandwidth-sensitive and needs to stream rather than buffer. It already
  does.
- Revoking a node must also close its tunnel, not only its credentials.
