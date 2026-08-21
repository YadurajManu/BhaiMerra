import { and, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { deployments, placementEvents, services, fleets } from '../db/schema.js'
import { fleetSnapshot, toServiceSpec } from '../scheduler/snapshot.js'
import { place } from '../scheduler/placement.js'
import { platformsFor } from '../build/runner.js'
import { allocateHostPort, invalidateRoutesForService } from '../ingress/routes.js'
import { recordAudit } from '../lib/audit.js'
import { dispatchEvent } from '../alerting/dispatch.js'

/**
 * Build, place and roll out one service at a commit.
 *
 * Shared by the webhook and the deploy endpoint so a push and a manual deploy
 * cannot drift apart — the whole point of the webhook is that it does exactly
 * what `fleet deploy` does.
 */
export async function deployFromPush(
  app: FastifyInstance,
  service: typeof services.$inferSelect,
  gitSha: string,
  contextRoot: string
): Promise<{ nodeId: string; nodeName: string; image: string }> {
  const ctx = app.ctx
  const fleetId = service.fleetId

  const [fleet] = await ctx.db.select().from(fleets).where(eq(fleets.id, fleetId)).limit(1)
  if (!fleet) throw new Error('fleet vanished mid-deploy')

  const { nodes: snapshot, placements, antiAffinityBy } = await fleetSnapshot(ctx, fleetId)
  const decision = place(toServiceSpec(service), snapshot, placements, antiAffinityBy)
  if (decision.outcome !== 'placed') throw new Error(decision.summary)

  let image = service.image ?? ''
  if (!image) {
    const arches = [
      ...new Set(
        snapshot
          .filter((n) => n.status === 'online')
          .map((n) => n.arch)
          .filter((a) => !service.compatibleArches.length || service.compatibleArches.includes(a))
      ),
    ]
    const built = await ctx.builds.build({
      serviceName: service.name,
      buildContext: service.buildContext ?? '.',
      gitSha,
      platforms: platformsFor(arches),
      registry: ctx.config.REGISTRY_URL ?? '',
      contextRoot,
    })
    image = built.imageTags[0]!
  }

  const hostPort = await allocateHostPort(ctx, decision.nodeId)

  await ctx.db.transaction(async (tx) => {
    await tx
      .update(deployments)
      .set({ status: 'superseded', finishedAt: new Date() })
      .where(
        and(eq(deployments.serviceId, service.id), inArray(deployments.status, ['deploying', 'running']))
      )

    await tx.insert(deployments).values({
      serviceId: service.id,
      gitSha,
      nodeId: decision.nodeId,
      status: 'deploying',
      imageTags: [image],
      hostPort,
    })

    await tx.insert(placementEvents).values({
      serviceId: service.id,
      toNodeId: decision.nodeId,
      reason: 'redeploy',
      detail: { score: decision.candidates[0]?.score, gitSha: gitSha.slice(0, 12), via: 'git push' },
    })

    await recordAudit(tx, {
      orgId: fleet.orgId,
      actorKind: 'system',
      action: 'service.deployed',
      targetType: 'service',
      targetId: service.id,
      metadata: { gitSha: gitSha.slice(0, 12), node: decision.nodeId, via: 'webhook' },
    })
  })

  await invalidateRoutesForService(ctx, service.id)

  await dispatchEvent(ctx, {
    type: 'deploy.succeeded',
    fleetId,
    at: new Date().toISOString(),
    subject: service.name,
    detail: { node: decision.nodeName, sha: gitSha.slice(0, 12), url: service.domain ?? service.hostname },
  })

  return { nodeId: decision.nodeId, nodeName: decision.nodeName, image }
}
