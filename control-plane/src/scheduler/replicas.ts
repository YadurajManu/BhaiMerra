import { and, desc, eq, inArray } from 'drizzle-orm'
import { deployments, placementEvents, services } from '../db/schema.js'
import { place } from './placement.js'
import { fleetSnapshot, toServiceSpec } from './snapshot.js'
import { allocateHostPort, invalidateRoutesForService } from '../ingress/routes.js'
import type { AppContext } from '../api/context.js'

/**
 * Keep the number of running copies equal to the number asked for.
 *
 * `replicas` has been in the schema, validated by the manifest, persisted, and
 * shipped to the agent since the beginning — and read by nothing. Writing
 * `replicas: 3` produced one container, silently.
 *
 * It is reconciled here rather than fanned out at deploy time, and that is a
 * deliberate choice rather than an easier one. A replica count is a statement
 * about how many copies should exist, not about what one request should do:
 * expressed as desired state it also repairs itself when a replica dies or its
 * node goes away, and it leaves the deploy path — the single most
 * consequential code in the system — completely untouched. A service with the
 * default of one replica takes exactly the path it always did.
 */

export type ScaleOutcome =
  | { service: string; action: 'scaled_up'; added: number; nodes: string[] }
  | { service: string; action: 'scaled_down'; removed: number }
  | { service: string; action: 'blocked'; reason: string }

/**
 * A replica needs something to run. The newest live deployment is what the
 * service is currently meant to be, so a new copy is that same image on
 * another node — never a rebuild, which could produce a different artifact
 * from the one already serving.
 */
type Template = {
  image: string[]
  gitSha: string | null
}

export async function reconcileReplicas(
  ctx: AppContext,
  fleetId: string,
  opts: { log?: { info: (o: unknown, m: string) => void } } = {}
): Promise<ScaleOutcome[]> {
  const outcomes: ScaleOutcome[] = []

  const wanted = await ctx.db
    .select()
    .from(services)
    .where(eq(services.fleetId, fleetId))
  const scaled = wanted.filter((s) => s.replicas > 1)
  if (!scaled.length) return outcomes

  for (const service of scaled) {
    // A volume cannot be shared. Two engines writing one data directory
    // corrupt it, and the manifest already warns about this — acting on it
    // here would turn a warning into an outage.
    if (service.persistentVolume) {
      outcomes.push({
        service: service.name,
        action: 'blocked',
        reason: `${service.replicas} replicas share one volume; scaled services must be stateless`,
      })
      continue
    }
    // Pinned means one named node, and a second copy on the same node would
    // contend for the same published port for no gain.
    if (service.placementPolicy === 'pinned') {
      outcomes.push({
        service: service.name,
        action: 'blocked',
        reason: 'a pinned service names one node, so it cannot have replicas across others',
      })
      continue
    }

    const live = await ctx.db
      .select({
        id: deployments.id,
        nodeId: deployments.nodeId,
        status: deployments.status,
        imageTags: deployments.imageTags,
        gitSha: deployments.gitSha,
        startedAt: deployments.startedAt,
      })
      .from(deployments)
      .where(
        and(
          eq(deployments.serviceId, service.id),
          inArray(deployments.status, ['deploying', 'running'])
        )
      )
      .orderBy(desc(deployments.startedAt))

    // Nothing running at all is a service that has never been deployed, or one
    // whose deploy is in flight. Neither is this function's business — it
    // scales what exists rather than starting what does not.
    if (!live.length) continue

    const template: Template = {
      image: (live[0]!.imageTags as string[]) ?? [],
      gitSha: live[0]!.gitSha,
    }
    if (!template.image.length) continue

    const delta = service.replicas - live.length
    if (delta === 0) continue

    if (delta < 0) {
      // Too many. Remove the newest extras rather than the oldest: the older
      // copies have been serving longer and are the ones proven to work.
      const excess = await ctx.db
        .select({ id: deployments.id })
        .from(deployments)
        .where(
          and(
            eq(deployments.serviceId, service.id),
            inArray(deployments.status, ['deploying', 'running'])
          )
        )
        .orderBy(desc(deployments.startedAt))
        .limit(-delta)

      await ctx.db
        .update(deployments)
        .set({ status: 'superseded', finishedAt: new Date() })
        .where(inArray(deployments.id, excess.map((e) => e.id)))
      await invalidateRoutesForService(ctx, service.id)

      outcomes.push({ service: service.name, action: 'scaled_down', removed: excess.length })
      opts.log?.info({ service: service.name, removed: excess.length }, 'scaled down to the declared replica count')
      continue
    }

    // Too few. Place each additional copy knowing where the others already
    // are, so anti-affinity and headroom scoring spread them rather than
    // stacking every replica on whichever node scored best once.
    const placedNodes: string[] = []
    for (let i = 0; i < delta; i++) {
      const { nodes: snapshot, placements, antiAffinityBy } = await fleetSnapshot(ctx, fleetId)

      // A replica is only useful somewhere the service is not already running.
      // Without this the scheduler happily returns the same node every time and
      // "three replicas" means three containers on one machine.
      const taken = new Set([
        ...live.map((d) => d.nodeId).filter((id): id is string => Boolean(id)),
        ...placedNodes,
      ])
      const elsewhere = snapshot.filter((n) => !taken.has(n.id))
      if (!elsewhere.length) {
        outcomes.push({
          service: service.name,
          action: 'blocked',
          reason: `wants ${service.replicas} replicas but the fleet has no further eligible node to put one on`,
        })
        break
      }

      const decision = place(toServiceSpec(service), elsewhere, placements, antiAffinityBy)
      if (decision.outcome !== 'placed') {
        outcomes.push({ service: service.name, action: 'blocked', reason: decision.summary })
        break
      }

      const hostPort = service.internal ? null : await allocateHostPort(ctx, decision.nodeId)
      await ctx.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(deployments)
          .values({
            serviceId: service.id,
            nodeId: decision.nodeId,
            gitSha: template.gitSha,
            imageTags: template.image,
            hostPort,
            status: 'deploying',
          })
          .returning({ id: deployments.id })

        await tx.insert(placementEvents).values({
          serviceId: service.id,
          toNodeId: decision.nodeId,
          reason: 'redeploy',
          detail: {
            replica: true,
            of: service.replicas,
            deployment: created!.id,
            score: decision.candidates[0]?.score ?? null,
          },
        })
      })

      placedNodes.push(decision.nodeId)
      live.push({
        id: 'pending',
        nodeId: decision.nodeId,
        status: 'deploying',
        imageTags: template.image,
        gitSha: template.gitSha,
        startedAt: new Date(),
      })
    }

    if (placedNodes.length) {
      await invalidateRoutesForService(ctx, service.id)
      outcomes.push({
        service: service.name,
        action: 'scaled_up',
        added: placedNodes.length,
        nodes: placedNodes,
      })
      opts.log?.info(
        { service: service.name, added: placedNodes.length },
        'scaled up to the declared replica count'
      )
    }
  }

  return outcomes
}
