import { and, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { deployments, placementEvents, services, fleets } from '../db/schema.js'
import { fleetSnapshot, toServiceSpec } from '../scheduler/snapshot.js'
import { place } from '../scheduler/placement.js'
import { platformsFor } from '../build/runner.js'
import { allocateHostPort, invalidateRoutesForService } from '../ingress/routes.js'
import { recordAudit } from '../lib/audit.js'
import { dispatchEvent } from '../alerting/dispatch.js'
import { openDeployment, phaseWriter } from './deploy-progress.js'

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

  // Opened before the build, and walked through the same phases as a manual
  // deploy, so a push shows the same progress and leaves the same trail when it
  // fails. See deploy-progress.ts for why the pre-deploy phases are invisible to
  // the agent, ingress and the scheduler.
  const deploymentId = await openDeployment(ctx, {
    serviceId: service.id,
    nodeId: decision.nodeId,
    gitSha,
  })
  const phases = phaseWriter(ctx, deploymentId)

  try {
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
      await phases.set('building')
      const built = await ctx.builds.build({
        serviceName: service.name,
        buildContext: service.buildContext ?? '.',
        gitSha,
        platforms: platformsFor(arches),
        registry: ctx.config.REGISTRY_URL ?? '',
        contextRoot,
        onProgress: phases.onBuildProgress,
      })
      image = built.imageTags[0]!
    }

    await phases.set('scheduling')
    const hostPort = await allocateHostPort(ctx, decision.nodeId)

    await ctx.db.transaction(async (tx) => {
      await tx
        .update(deployments)
        .set({ status: 'superseded', finishedAt: new Date() })
        .where(
          and(eq(deployments.serviceId, service.id), inArray(deployments.status, ['deploying', 'running']))
        )

      // Going live is this row's last phase, not a second insert.
      await tx
        .update(deployments)
        .set({ status: 'deploying', imageTags: [image], hostPort })
        .where(eq(deployments.id, deploymentId))

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

    await phases.clear().catch(() => {})

    await invalidateRoutesForService(ctx, service.id)

    await dispatchEvent(ctx, {
      type: 'deploy.succeeded',
      fleetId,
      at: new Date().toISOString(),
      subject: service.name,
      detail: { node: decision.nodeName, sha: gitSha.slice(0, 12), url: service.domain ?? service.hostname },
    }, { email: ctx.email })

    return { nodeId: decision.nodeId, nodeName: decision.nodeName, image }
  } catch (err) {
    // A push that fails to build has nobody watching a terminal, so the row is
    // the only place the reason can live.
    await phases
      .fail(err instanceof Error ? err.message : 'deploy failed')
      .catch((writeErr) => app.log.error({ err: writeErr, deploymentId }, 'could not record deploy failure'))
    throw err
  }
}
