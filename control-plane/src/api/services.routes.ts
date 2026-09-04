import { and, eq, ne, desc, inArray, gte, count } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { services, deployments, nodes, fleets, placementEvents } from '../db/schema.js'
import { parseManifest, ManifestError } from '../manifest/parse.js'
import { syncManifest } from '../manifest/sync.js'
import { place } from '../scheduler/placement.js'
import { fleetSnapshot, toServiceSpec } from '../scheduler/snapshot.js'
import { platformsFor, BuildUnavailableError } from '../build/runner.js'
import {
  extractContext,
  disposeContext,
  contextPath,
  assertValidContextId,
  MAX_CONTEXT_BYTES,
} from '../build/context.js'
import { managedHostname, allocateHostPort, invalidateRoutesForService, invalidateRouteHosts } from '../ingress/routes.js'
import { recordAudit } from '../lib/audit.js'
import { resolveSecrets } from '../secrets/store.js'
import { ApiError } from './errors.js'
import { openDeployment, phaseWriter, readProgress } from './deploy-progress.js'
import { requireFleetPermission } from './guards.js'

export async function serviceRoutes(app: FastifyInstance) {
  const { db } = app.ctx

  /** POST /fleets/:fleetId/services — apply a fleet.yaml (FR-4). */
  app.post(
    '/fleets/:fleetId/services',
    { preHandler: requireFleetPermission('service.create') },
    async (req, reply) => {
      const body = z
        .object({
          manifest: z.string().min(1, 'manifest is required'),
          /**
           * What to call these services when the manifest does not name itself.
           * The CLI sends the directory name, the way Compose does. A `project:`
           * key inside the manifest always wins.
           */
          project: z
            .string()
            .regex(/^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/)
            .optional(),
        })
        .safeParse(req.body)
      if (!body.success) {
        throw ApiError.badRequest('missing_manifest', 'Send the fleet.yaml contents as { manifest }')
      }

      const { fleetId } = req.params as { fleetId: string }

      let parsed
      try {
        // The project scopes generated volume names, so it has to be known
        // before the manifest is expanded rather than after.
        parsed = parseManifest(body.data.manifest, body.data.project)
      } catch (err) {
        if (err instanceof ManifestError) {
          // Every problem at once — fixing a manifest one error per deploy is
          // a miserable loop.
          throw ApiError.unprocessable('invalid_manifest', 'fleet.yaml is not valid', err.issues)
        }
        throw err
      }

      const result = await syncManifest(
        app.ctx,
        fleetId,
        req.orgId!,
        parsed,
        req.userId,
        body.data.project
      )
      return reply.code(200).send({ fleet: parsed.fleet, ...result })
    }
  )

  /** Dry run: validate without touching anything. */
  app.post(
    '/fleets/:fleetId/services/validate',
    { preHandler: requireFleetPermission('service.read') },
    async (req) => {
      const body = z.object({ manifest: z.string().min(1) }).safeParse(req.body)
      if (!body.success) throw ApiError.badRequest('missing_manifest', 'Send { manifest }')

      try {
        const parsed = parseManifest(body.data.manifest)
        return {
          valid: true,
          fleet: parsed.fleet,
          services: parsed.services.map((s) => ({
            name: s.name,
            placement: s.placement,
            ramMb: s.resources.ram,
            arch: s.arch,
          })),
          warnings: parsed.warnings,
        }
      } catch (err) {
        if (err instanceof ManifestError) return { valid: false, issues: err.issues }
        throw err
      }
    }
  )

  app.get(
    '/fleets/:fleetId/services',
    { preHandler: requireFleetPermission('service.read') },
    async (req) => {
      const { fleetId } = req.params as { fleetId: string }
      const rows = await db.select().from(services).where(eq(services.fleetId, fleetId))

      const live = await db
        .select({
          serviceId: deployments.serviceId,
          nodeId: deployments.nodeId,
          nodeName: nodes.name,
          status: deployments.status,
          gitSha: deployments.gitSha,
        })
        .from(deployments)
        .leftJoin(nodes, eq(nodes.id, deployments.nodeId))
        .where(
          and(
            inArray(deployments.serviceId, rows.length ? rows.map((r) => r.id) : ['00000000-0000-0000-0000-000000000000']),
            inArray(deployments.status, ['deploying', 'running', 'pinned_unavailable'])
          )
        )
        // A service can briefly have two live deployments — the one being
        // rolled out and the one still serving. Without an order the Map kept
        // whichever row the database happened to return last, so the same
        // request could report "running" or "deploying" for the same service
        // from one poll to the next. `fleet up` believed one of those and
        // declared a rollout finished that had not started.
        .orderBy(desc(deployments.startedAt))

      // Newest wins: later entries overwrite earlier ones, so iterate oldest
      // first and let the most recent deployment land last.
      const byService = new Map([...live].reverse().map((d) => [d.serviceId, d]))

      // The most recent deployment whatever its outcome.
      //
      // `current` only ever holds a live state, so a service whose deployment
      // failed has `current: null` and renders as "not placed" — accurate, and
      // useless. The reason it failed is sitting in this table; without it the
      // only way to learn why a service is down was to open a shell on the
      // node, which is precisely what a control plane exists to avoid.
      const lastRows = rows.length
        ? await db
            .selectDistinctOn([deployments.serviceId], {
              serviceId: deployments.serviceId,
              // The id, so the dashboard can ask for a reading of this exact
              // failure without navigating to the detail page first.
              id: deployments.id,
              status: deployments.status,
              failureReason: deployments.failureReason,
              startedAt: deployments.startedAt,
              finishedAt: deployments.finishedAt,
              nodeName: nodes.name,
              gitSha: deployments.gitSha,
            })
            .from(deployments)
            .leftJoin(nodes, eq(nodes.id, deployments.nodeId))
            .where(inArray(deployments.serviceId, rows.map((r) => r.id)))
            .orderBy(deployments.serviceId, desc(deployments.startedAt))
        : []
      const lastByService = new Map(lastRows.map((d) => [d.serviceId, d]))

      // How many recent failures each service has.
      //
      // A count, not the rows: the dashboard only needs to know whether there
      // is history worth offering, and this list is polled continuously. The
      // failures themselves are fetched from /deployments when somebody asks
      // to see them.
      //
      // Bounded by a window rather than returning everything ever. A service
      // that failed thirty times last month and has been healthy since is not
      // usefully described as "30 failures", and the number would only grow.
      const failureRows = rows.length
        ? await db
            .select({ serviceId: deployments.serviceId, count: count() })
            .from(deployments)
            .where(
              and(
                inArray(deployments.serviceId, rows.map((r) => r.id)),
                eq(deployments.status, 'failed'),
                gte(deployments.startedAt, new Date(Date.now() - 7 * 24 * 60 * 60_000))
              )
            )
            .groupBy(deployments.serviceId)
        : []
      const failuresByService = new Map(failureRows.map((r) => [r.serviceId, Number(r.count)]))

      return {
        services: rows.map((s) => ({
          ...s,
          current: byService.get(s.id) ?? null,
          last: lastByService.get(s.id) ?? null,
          recentFailures: failuresByService.get(s.id) ?? 0,
        })),
      }
    }
  )

  /** Latest node-provided log tail. Nodes only make outbound connections, so
   * this is served from the heartbeat snapshot rather than opening SSH/Docker
   * ports back into private networks. */
  app.get(
    '/services/:serviceId/logs',
    { preHandler: requireServicePermission('service.read') },
    async (req) => {
      const { service } = await loadService(app, req.params as { serviceId: string })
      const query = z.object({ node: z.string().uuid().optional() }).parse(req.query ?? {})
      const current = await db
        .select({ nodeId: deployments.nodeId, nodeName: nodes.name })
        .from(deployments).leftJoin(nodes, eq(nodes.id, deployments.nodeId))
        .where(and(eq(deployments.serviceId, service.id), inArray(deployments.status, ['deploying', 'running'])))
        .orderBy(desc(deployments.startedAt)).limit(1)
      const target = query.node
        ? (await db.select({ id: nodes.id, name: nodes.name }).from(nodes).where(eq(nodes.id, query.node)).limit(1))[0]
        : current[0]?.nodeId ? { id: current[0].nodeId, name: current[0].nodeName ?? 'unknown' } : null
      if (!target) throw ApiError.unprocessable('logs_unavailable', `No active node for "${service.name}"`)
      const hb = await app.ctx.heartbeats.last(target.id)
      const log = hb?.logs?.find((entry) => entry.service === service.name)
      return {
        service: service.name,
        node: { id: target.id, name: target.name },
        capturedAt: hb ? new Date(hb.at).toISOString() : null,
        available: Boolean(log),
        lines: log?.text.split(/\r?\n/).filter(Boolean) ?? [],
        diagnostic: log ? null : 'The agent has not reported a container log tail yet. Confirm Docker is available and the service has started.',
      }
    }
  )

  /** Restart is an immutable replacement: a new deployment ID asks the agent
   * to recreate the same artifact, preserving a truthful deployment history. */
  app.post(
    '/services/:serviceId/restart',
    { preHandler: requireServicePermission('service.deploy') },
    async (req, reply) => {
      const { service, orgId } = await loadService(app, req.params as { serviceId: string })
      const [current] = await db.select().from(deployments)
        .where(and(eq(deployments.serviceId, service.id), inArray(deployments.status, ['deploying', 'running'])))
        .orderBy(desc(deployments.startedAt)).limit(1)
      if (!current || !current.nodeId) throw ApiError.unprocessable('not_running', `"${service.name}" has no deployment to restart`)
      const [created] = await db.transaction(async (tx) => {
        await tx.update(deployments).set({ status: 'superseded', finishedAt: new Date() }).where(eq(deployments.id, current.id))
        const created = await tx.insert(deployments).values({ serviceId: service.id, gitSha: current.gitSha, imageTags: current.imageTags, nodeId: current.nodeId, hostPort: current.hostPort, status: 'deploying' }).returning()
        await recordAudit(tx, { orgId, actorUserId: req.userId, action: 'service.restarted', targetType: 'service', targetId: service.id, metadata: { fromDeployment: current.id, deployment: created[0]!.id } })
        return created
      })
      await invalidateRoutesForService(app.ctx, service.id)
      return reply.code(201).send({ deployment: created!, note: 'The agent will replace the container on its next reconciliation.' })
    }
  )

  /** POST /services/:serviceId/stop — stop running deployments for a service. */
  app.post(
    '/services/:serviceId/stop',
    { preHandler: requireServicePermission('service.deploy') },
    async (req, reply) => {
      const { service, orgId } = await loadService(app, req.params as { serviceId: string })
      const active = await db.select().from(deployments)
        .where(and(eq(deployments.serviceId, service.id), inArray(deployments.status, ['deploying', 'running'])))

      if (!active.length) {
        return reply.code(200).send({ stopped: 0, service: service.name, message: `"${service.name}" is not currently running.` })
      }

      await db.transaction(async (tx) => {
        for (const dep of active) {
          await tx.update(deployments).set({ status: 'superseded', finishedAt: new Date() }).where(eq(deployments.id, dep.id))
        }
        await recordAudit(tx, {
          orgId,
          actorUserId: req.userId,
          action: 'service.stopped',
          targetType: 'service',
          targetId: service.id,
          metadata: { count: active.length, stoppedDeploymentIds: active.map((d) => d.id) },
        })
      })

      await invalidateRoutesForService(app.ctx, service.id)
      return reply.code(200).send({
        stopped: active.length,
        service: service.name,
        note: 'Service stopped. The agent will remove the container on its next reconciliation.',
      })
    }
  )

  /**
   * Permanently remove a service from the fleet.
   *
   * Deleting the service row cascades its deployments away, which is what
   * actually stops the workload: /agent/desired-state joins deployments to
   * services, so the container simply stops being listed and the agent removes
   * it on its next reconciliation. There is no push channel to a node, and
   * that is deliberate — agents are outbound-only.
   *
   * Requires admin rather than deployer. Deleting a service is strictly more
   * destructive than deploying one, and it matches `service.create` /
   * `service.update`: whoever can bring a service into existence is who can
   * take it out of existence.
   */
  app.delete(
    '/services/:serviceId',
    { preHandler: requireServicePermission('service.update') },
    async (req, reply) => {
      const { service, orgId } = await loadService(app, req.params as { serviceId: string })

      // Read the hostnames while the row still exists — after the delete there
      // is nothing to resolve them from, and a stale cached route would keep
      // answering for a service that is gone.
      const hosts = [service.hostname, service.domain]

      const active = await db
        .select({ id: deployments.id })
        .from(deployments)
        .where(and(eq(deployments.serviceId, service.id), inArray(deployments.status, ['deploying', 'running'])))

      await db.transaction(async (tx) => {
        // deployments.serviceId cascades, so the placements go with the service.
        await tx.delete(services).where(eq(services.id, service.id))
        await recordAudit(tx, {
          orgId,
          actorUserId: req.userId,
          action: 'service.deleted',
          targetType: 'service',
          targetId: service.id,
          metadata: { name: service.name, stoppedDeployments: active.length },
        })
      })

      await invalidateRouteHosts(app.ctx, hosts)
      return reply.code(200).send({
        deleted: true,
        service: service.name,
        stopped: active.length,
        note: active.length
          ? 'Service deleted. The agent will remove its container on the next reconciliation.'
          : 'Service deleted. It was not running.',
      })
    }
  )

  /** Roll back to a previously successful artifact. The old release remains
   * visible and a new deployment records the recovery action. */
  app.post(
    '/services/:serviceId/rollback',
    { preHandler: requireServicePermission('service.deploy') },
    async (req, reply) => {
      const body = z.object({ deploymentId: z.string().uuid().optional() }).parse(req.body ?? {})
      const { service, orgId } = await loadService(app, req.params as { serviceId: string })
      const history = await db.select().from(deployments).where(eq(deployments.serviceId, service.id)).orderBy(desc(deployments.startedAt)).limit(50)
      const current = history.find((d) => d.status === 'deploying' || d.status === 'running')
      const target = body.deploymentId
        ? history.find((d) => d.id === body.deploymentId)
        : history.find((d) => d.id !== current?.id && d.status === 'superseded' && d.imageTags.length)
      if (!target || !target.imageTags.length) throw ApiError.unprocessable('no_rollback_target', `No previous release is available for "${service.name}"`)
      const nodeId = current?.nodeId ?? target.nodeId
      if (!nodeId) throw ApiError.unprocessable('no_rollback_target', 'The previous release has no node assignment')
      const [created] = await db.transaction(async (tx) => {
        if (current) await tx.update(deployments).set({ status: 'superseded', finishedAt: new Date() }).where(eq(deployments.id, current.id))
        const created = await tx.insert(deployments).values({ serviceId: service.id, gitSha: target.gitSha, imageTags: target.imageTags, nodeId, hostPort: current?.hostPort ?? target.hostPort, status: 'deploying' }).returning()
        await recordAudit(tx, { orgId, actorUserId: req.userId, action: 'service.rolled_back', targetType: 'service', targetId: service.id, metadata: { fromDeployment: current?.id, targetDeployment: target.id, deployment: created[0]!.id } })
        return created
      })
      await invalidateRoutesForService(app.ctx, service.id)
      return reply.code(201).send({ deployment: created!, rolledBackTo: target.id, note: 'The agent will restore this release on its next reconciliation.' })
    }
  )

  /**
   * Where would this go, and why? Answers the question before a deploy rather
   * than after, and is the same code path the scheduler actually uses.
   */
  app.get(
    '/services/:serviceId/placement-preview',
    { preHandler: requireServicePermission('service.read') },
    async (req) => {
      const { service, fleetId } = await loadService(app, req.params as { serviceId: string })
      const { nodes: snapshot, placements, antiAffinityBy } = await fleetSnapshot(app.ctx, fleetId)
      const decision = place(toServiceSpec(service), snapshot, placements, antiAffinityBy)
      return { service: service.name, decision }
    }
  )

  /**
   * Upload a build context.
   *
   * The counterpart to a git checkout: the CLI sends the directory it would
   * have pushed, and the deploy that follows builds it exactly as it builds a
   * pushed commit — multi-arch, tagged for the registry the nodes can reach.
   * Without this, `build:` only ever worked through a webhook.
   */
  app.post(
    '/services/:serviceId/build-context',
    {
      preHandler: requireServicePermission('service.deploy'),
      // The global limit is 1MB, which is right for JSON and useless here.
      bodyLimit: MAX_CONTEXT_BYTES,
    },
    async (req, reply) => {
      const archive = req.body
      if (!Buffer.isBuffer(archive)) {
        throw ApiError.badRequest(
          'invalid_context',
          'Send the build context as a gzipped tar with content-type application/gzip'
        )
      }

      const { service } = await loadService(app, req.params as { serviceId: string })
      const uploaded = await extractContext(app.ctx.config.BUILD_WORKDIR, archive)

      req.log.info(
        { service: service.name, contextId: uploaded.id, bytes: archive.length },
        'build context uploaded'
      )

      return reply.code(201).send({
        contextId: uploaded.id,
        bytes: archive.length,
        note: 'Pass this as contextId on the next deploy. It is removed once the build finishes.',
      })
    }
  )

  /** POST /services/:id/deploy — schedule a deployment (FR-3 build is Phase 2). */
  /**
   * Explain why a deployment failed.
   *
   * A POST because it may spend money and consume an allowance, even though it
   * reads. Answers are cached by failure signature, so the common case - the
   * same broken lockfile twice - costs nothing and is not counted.
   */
  app.post(
    '/fleets/:fleetId/deployments/:deploymentId/explain',
    { preHandler: requireFleetPermission('service.read') },
    async (req, reply) => {
      const { fleetId, deploymentId } = req.params as { fleetId: string; deploymentId: string }
      const { explainDeployment, usageToday, DAILY_LIMIT } = await import('../ai/explain.js')

      const out = await explainDeployment(app.ctx, { fleetId, deploymentId, userId: req.userId! })
      const used = await usageToday(app.ctx, req.userId!)

      // The meter travels with every answer, so the limit is never a surprise
      // that only appears at the moment it stops you.
      return reply.send({ ...out, usage: { used, limit: DAILY_LIMIT } })
    }
  )

  /**
   * A second opinion on a generated fleet.yaml.
   *
   * Sits beside the validate endpoint deliberately: both answer "is this
   * right?" before anything is applied, and neither writes.
   */
  app.post(
    '/fleets/:fleetId/manifest/assist',
    // Same permission the apply it precedes requires: this only ever suggests,
    // but suggesting a manifest to somebody who could not apply one is noise.
    { preHandler: requireFleetPermission('service.create') },
    async (req, reply) => {
      const body = z
        .object({
          draft: z.string().min(1).max(64_000),
          // Bounded because it is pasted into a prompt: a repository that
          // large has more to say than a model can read anyway, and the CLI
          // trims it to the evidence before sending.
          repoMap: z.string().min(1).max(64_000),
        })
        .parse(req.body ?? {})

      const { assistManifest } = await import('../ai/manifest.js')
      const out = await assistManifest(app.ctx, {
        userId: req.userId!,
        draft: body.draft,
        repoMap: body.repoMap,
      })
      return reply.send(out)
    }
  )

  app.post(
    '/services/:serviceId/deploy',
    { preHandler: requireServicePermission('service.deploy') },
    async (req, reply) => {
      const body = z
        .object({
          gitSha: z.string().max(64).optional(),
          image: z.string().max(512).optional(),
          /** An upload from POST /services/:id/build-context. */
          contextId: z.string().max(64).optional(),
        })
        .parse(req.body ?? {})
      if (body.contextId) assertValidContextId(body.contextId)

      const { service, fleetId, orgId } = await loadService(app, req.params as { serviceId: string })
      const { nodes: snapshot, placements, antiAffinityBy } = await fleetSnapshot(app.ctx, fleetId)

      const decision = place(toServiceSpec(service), snapshot, placements, antiAffinityBy)
      if (decision.outcome !== 'placed') {
        // Exit code 3 in the CLI. The rejection list is the useful part.
        throw new ApiError(422, 'no_eligible_node', decision.summary, {
          rejected: decision.rejected,
          warnings: decision.warnings,
        })
      }

      // Checked before anything is built or written. A service whose secrets
      // are not set will start, fail to connect, and exit — and the operator
      // gets to read that as a crash loop instead of as the one-line
      // configuration error it actually is.
      const { missing } = await resolveSecrets(app.ctx, fleetId, service.id, service.secretRefs)
      if (missing.length) {
        throw ApiError.unprocessable(
          'missing_secrets',
          `"${service.name}" needs ${missing.length === 1 ? 'a secret that is' : 'secrets that are'} not set: ${missing.join(', ')}.`,
          missing.map((key) => `fleet secrets set ${key}`)
        )
      }

      let image = body.image ?? service.image

      // Decide what will be built, if anything, *before* a row exists. A service
      // with neither an image nor a build context is a configuration error, and
      // recording it as a failed deployment would only bury the real problem.
      //
      // Every architecture present among *eligible* nodes is built, not just the
      // winner's: a later failover must not be blocked by a missing arch.
      let buildPlan: { buildContext: string; platforms: string[] } | null = null
      if (!image) {
        if (!service.buildContext) {
          throw ApiError.unprocessable(
            'no_image_or_build',
            `"${service.name}" has neither an image nor a build context.`
          )
        }

        const eligibleArches = [
          ...new Set(
            snapshot
              .filter((n) => n.status === 'online')
              .map((n) => n.arch)
              .filter((a) => !service.compatibleArches.length || service.compatibleArches.includes(a))
          ),
        ]
        const platforms = platformsFor(eligibleArches)
        if (!platforms.length) {
          throw ApiError.unprocessable(
            'no_buildable_platform',
            `No online node in this fleet has an architecture "${service.name}" can be built for.`
          )
        }
        buildPlan = { buildContext: service.buildContext, platforms }
      }

      // From here the deploy is really being attempted, so it gets a row. The
      // row walks queued → building → pushing → scheduling → deploying, which is
      // what the CLI polls to draw a deploy that takes minutes, and what leaves a
      // failed build somewhere `fleet deployments` can find it.
      const deploymentId = await openDeployment(app.ctx, {
        serviceId: service.id,
        nodeId: decision.nodeId,
        gitSha: body.gitSha ?? null,
      })
      const phases = phaseWriter(app.ctx, deploymentId)

      /*
       * Answer now; build afterwards.
       *
       * This used to hold the HTTP request open for the whole build, which
       * made "how long may a build take" a question about proxies rather than
       * about builds. Cloudflare cuts an origin request at about 100 seconds,
       * so a perfectly healthy multi-arch build died at 124s with a 524 and
       * the row was left saying `building` forever. Any real project exceeds
       * that; an arm64 build under QEMU exceeds it several times over.
       *
       * The deployment row and the phase writer are the durable record, and
       * the client already follows them - /progress for the live line, then
       * the service list until the status is terminal. So the response is the
       * receipt, and the work continues without anybody holding a socket open
       * for it.
       */
        const runDeploy = async () => {
          try {
          let finalImage: string
          if (buildPlan) {
            await phases.set('building')
            const gitSha = body.gitSha ?? 'latest'
            const built = await app.ctx.builds.build({
              serviceName: service.name,
              // An upload *is* the context: the CLI resolved `build: ./api`
              // against the manifest's directory before packing, so the archive
              // root is already the directory to build. Joining the path on
              // again looks for ./api inside ./api.
              //
              // A checkout is the other way round — it is the whole repository,
              // and the manifest's path selects a directory within it.
              buildContext: body.contextId ? '.' : buildPlan.buildContext,
              contextRoot: body.contextId
                ? contextPath(app.ctx.config.BUILD_WORKDIR, body.contextId)
                : undefined,
              gitSha,
              platforms: buildPlan.platforms,
              registry: app.ctx.config.REGISTRY_URL ?? '',
              onProgress: phases.onBuildProgress,
            })
            finalImage = built.imageTags[0]!
            req.log.info(
              {
                service: service.name,
                platforms: buildPlan.platforms,
                image: finalImage,
                durationMs: built.durationMs,
              },
              'multi-arch build complete'
            )
          } else {
            // Only reachable with an image: a service without one always produced
            // a build plan above.
            finalImage = image!
          }

          await phases.set('scheduling')
          // Allocated per node, so the ingress proxy has somewhere to send
          // traffic. An internal service gets none on purpose: publishing a port
          // binds it on the node's interface, which is how a database ends up
          // reachable from the whole LAN. Its neighbours reach it by name on the
          // fleet network instead.
          const hostPort = service.internal ? null : await allocateHostPort(app.ctx, decision.nodeId)

          const deployment = await app.ctx.db.transaction(async (tx) => {
            // A stateful service cannot overlap. Two Postgres processes writing
            // one volume corrupt it, so for these the old release is superseded
            // now and the node replaces the container in place. The downtime is
            // real and is the correct trade: a moment offline is recoverable,
            // and a corrupted volume is not.
            if (service.persistentVolume) {
              await tx
                .update(deployments)
                .set({ status: 'superseded', finishedAt: new Date() })
                .where(
                  and(
                    eq(deployments.serviceId, service.id),
                    ne(deployments.id, deploymentId),
                    inArray(deployments.status, ['deploying', 'running'])
                  )
                )
            }

            // For everything else the previous release is deliberately *not*
            // superseded here.
            //
            // It used to be, which meant the moment a deploy was scheduled the old
            // release stopped being the live one — before the new container had
            // been pulled, let alone proved it could serve a request. That is the
            // whole outage: the site was down from the instant the deploy started
            // until the replacement happened to come up, and if the replacement
            // never came up, it stayed down.
            //
            // Both rows are live for the length of the rollout. Ingress prefers
            // the running one, so traffic keeps reaching the old release, and the
            // heartbeat supersedes it at the moment the new one reports healthy.
            //
            // A stateful service is the exception and is handled on the node: two
            // containers cannot share one volume without corrupting it.

            // The row already exists; going live is its last phase, not a second
            // insert. Two rows per deploy would double every history view.
            const [row] = await tx
              .update(deployments)
              .set({ status: 'deploying', imageTags: [finalImage], hostPort })
              .where(eq(deployments.id, deploymentId))
              .returning()

            await tx.insert(placementEvents).values({
              serviceId: service.id,
              fromNodeId: null,
              toNodeId: decision.nodeId,
              reason: 'manual',
              detail: {
                score: decision.candidates[0]?.score,
                breakdown: decision.candidates[0]?.breakdown,
                consideredNodes: decision.candidates.length,
              },
            })

            await recordAudit(tx, {
              orgId,
              actorUserId: req.userId,
              action: 'service.deployed',
              targetType: 'service',
              targetId: service.id,
              metadata: { node: decision.nodeName, image: finalImage, gitSha: body.gitSha },
            })

            return row!
          })

          // The build line has served its purpose; the phase on the row is the
          // durable record from here on.
          await phases.clear().catch(() => {})

          req.log.info({ service: service.name, deploymentId }, 'deploy complete')
          } catch (err) {
            // Written to the row, not thrown: the caller already has its 202 and
            // nothing is listening. The row is the only place this can be read
            // from afterwards, which is exactly what makes it the record.
            const reason = err instanceof Error ? err.message : 'deploy failed'
            await phases.fail(reason).catch((writeErr) => {
              req.log.error({ err: writeErr, deploymentId }, 'could not record deploy failure')
            })
            req.log.warn(
              { err, deploymentId, service: service.name, platforms: buildPlan?.platforms ?? [] },
              'deploy failed'
            )
          } finally {
            // Customer source is held only for as long as it takes to build it;
            // a control plane that keeps every upload runs out of disk in a week.
            if (body.contextId) {
              await disposeContext(app.ctx.config.BUILD_WORKDIR, body.contextId).catch((err) => {
                req.log.warn({ err, contextId: body.contextId }, 'could not remove the build context')
              })
            }
          }
        }

        // Fire and record. Nothing awaits this - the point is that the caller is
        // already gone. runDeploy handles its own failures; this catch is the
        // backstop, because an unhandled rejection here would take the process
        // down and every other fleet with it.
        const running = runDeploy()
          .catch((err) => {
            req.log.error({ err, deploymentId }, 'deploy escaped its own error handling')
          })
          .finally(() => {
            app.ctx.deploysInFlight.delete(deploymentId)
          })
        // Registered so the work is observable: a shutdown can wait for it
        // rather than leaving a row saying `building` for ever, which is
        // exactly what a killed build looks like afterwards.
        app.ctx.deploysInFlight.set(deploymentId, running)

        return reply.code(202).send({
          deployment: { id: deploymentId, status: 'deploying' },
          placedOn: { id: decision.nodeId, name: decision.nodeName },
          // The point of the whole exercise: a URL, handed back on deploy.
          // An internal service has none, and says how it is reached instead.
          url: service.internal
            ? null
            : service.domain
              ? `https://${service.domain}`
              : service.hostname
                ? `https://${service.hostname}`
                : null,
          reachableAs: service.internal ? `${service.name}:${service.containerPort}` : null,
          score: decision.candidates[0]?.score,
          warnings: decision.warnings,
          note: 'Building and scheduling continue; follow /progress or the service status.',
        })
    }
  )

  /**
   * Where a deploy has got to. Polled every second or so by the CLI while it
   * draws the progress ladder, which is why it is one indexed row plus one Redis
   * read and nothing else.
   */
  app.get(
    '/services/:serviceId/progress',
    { preHandler: requireServicePermission('service.read') },
    async (req) => {
      const { service } = await loadService(app, req.params as { serviceId: string })
      const progress = await readProgress(app.ctx, service.id)
      return { service: service.name, progress }
    }
  )

  /** Manual override (§6). */
  app.post(
    '/services/:serviceId/reschedule',
    { preHandler: requireServicePermission('service.reschedule') },
    async (req) => {
      const { service, fleetId, orgId } = await loadService(app, req.params as { serviceId: string })
      if (service.placementPolicy === 'pinned') {
        throw ApiError.unprocessable(
          'service_pinned',
          `"${service.name}" is pinned. Change its placement policy before moving it.`
        )
      }

      const [current] = await db
        .select()
        .from(deployments)
        .where(
          and(eq(deployments.serviceId, service.id), inArray(deployments.status, ['deploying', 'running']))
        )
        .limit(1)
      if (!current) throw ApiError.unprocessable('not_running', `"${service.name}" is not running`)

      const { nodes: snapshot, placements, antiAffinityBy } = await fleetSnapshot(app.ctx, fleetId)
      // Exclude where it is now, or "reschedule" would be a no-op.
      const elsewhere = snapshot.filter((n) => n.id !== current.nodeId)
      const decision = place(toServiceSpec(service), elsewhere, placements, antiAffinityBy)

      if (decision.outcome !== 'placed') {
        throw new ApiError(422, 'no_eligible_node', decision.summary, { rejected: decision.rejected })
      }

      // Ports are per node, so moving means allocating on the new one.
      const hostPort = await allocateHostPort(app.ctx, decision.nodeId)

      await app.ctx.db.transaction(async (tx) => {
        await tx
          .update(deployments)
          .set({ status: 'superseded', finishedAt: new Date() })
          .where(eq(deployments.id, current.id))
        await tx.insert(deployments).values({
          hostPort,
          serviceId: service.id,
          gitSha: current.gitSha,
          imageTags: current.imageTags,
          nodeId: decision.nodeId,
          status: 'deploying',
        })
        await tx.insert(placementEvents).values({
          serviceId: service.id,
          fromNodeId: current.nodeId,
          toNodeId: decision.nodeId,
          reason: 'manual',
          detail: { score: decision.candidates[0]?.score, forced: true },
        })
        await recordAudit(tx, {
          orgId,
          actorUserId: req.userId,
          action: 'service.rescheduled',
          targetType: 'service',
          targetId: service.id,
          metadata: { from: current.nodeId, to: decision.nodeId, reason: 'manual' },
        })
      })

      // The URL must point at the new node before the caller sees success.
      await invalidateRoutesForService(app.ctx, service.id)

      return { movedTo: { id: decision.nodeId, name: decision.nodeName }, score: decision.candidates[0]?.score }
    }
  )

  app.get(
    '/services/:serviceId/deployments',
    { preHandler: requireServicePermission('service.read') },
    async (req) => {
      const { service } = await loadService(app, req.params as { serviceId: string })
      const rows = await db
        .select({ deployment: deployments, nodeName: nodes.name })
        .from(deployments)
        .leftJoin(nodes, eq(nodes.id, deployments.nodeId))
        .where(eq(deployments.serviceId, service.id))
        .orderBy(desc(deployments.startedAt))
        .limit(50)
      return { deployments: rows.map((r) => ({ ...r.deployment, nodeName: r.nodeName })) }
    }
  )

  /** GET /fleets/:id/placement-map (§6). */
  app.get(
    '/fleets/:fleetId/placement-map',
    { preHandler: requireFleetPermission('fleet.read') },
    async (req) => {
      const { fleetId } = req.params as { fleetId: string }
      const { nodes: snapshot } = await fleetSnapshot(app.ctx, fleetId)

      const live = await db
        .select({
          serviceName: services.name,
          policy: services.placementPolicy,
          nodeId: deployments.nodeId,
          status: deployments.status,
          ramMb: services.requestRamMb,
        })
        .from(deployments)
        .innerJoin(services, eq(services.id, deployments.serviceId))
        .where(
          and(
            eq(services.fleetId, fleetId),
            // A pinned service held on a downed node must stay visible on that
            // node. Dropping it here is how "not moved" becomes "vanished".
            inArray(deployments.status, ['deploying', 'running', 'pinned_unavailable'])
          )
        )

      return {
        nodes: snapshot.map((n) => ({
          id: n.id,
          name: n.name,
          arch: n.arch,
          status: n.status,
          reliabilityTier: n.reliabilityTier,
          ramMb: n.ramMb,
          committedRamMb: n.committedRamMb,
          freeRamMb: Math.max(0, n.ramMb - n.committedRamMb),
          loadFactor: n.loadFactor ?? null,
          services: live
            .filter((s) => s.nodeId === n.id)
            .map((s) => ({ name: s.serviceName, policy: s.policy, status: s.status, ramMb: s.ramMb })),
        })),
        unplaced: live.filter((s) => !s.nodeId).map((s) => s.serviceName),
      }
    }
  )

  /** GET /fleets/:id/events — the unified timeline (§6, PRD 7.6). */
  app.get(
    '/fleets/:fleetId/events',
    { preHandler: requireFleetPermission('events.read') },
    async (req) => {
      const { fleetId } = req.params as { fleetId: string }
      const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query ?? {})

      const rows = await db
        .select({
          id: placementEvents.id,
          at: placementEvents.createdAt,
          service: services.name,
          reason: placementEvents.reason,
          from: placementEvents.fromNodeId,
          to: placementEvents.toNodeId,
          detail: placementEvents.detail,
        })
        .from(placementEvents)
        .innerJoin(services, eq(services.id, placementEvents.serviceId))
        .where(eq(services.fleetId, fleetId))
        .orderBy(desc(placementEvents.createdAt))
        .limit(q.limit)

      const nodeRows = await db.select({ id: nodes.id, name: nodes.name }).from(nodes).where(eq(nodes.fleetId, fleetId))
      const nameOf = new Map(nodeRows.map((n) => [n.id, n.name]))

      return {
        events: rows.map((e) => ({
          id: e.id,
          at: e.at,
          type: 'service.placed',
          service: e.service,
          reason: e.reason,
          from: e.from ? nameOf.get(e.from) ?? e.from : null,
          to: e.to ? nameOf.get(e.to) ?? e.to : null,
          detail: e.detail,
        })),
      }
    }
  )
}

/* ── helpers ─────────────────────────────────────────────────────── */

/**
 * Service routes are keyed by service id, not fleet id, so permission has to
 * be resolved through the service's fleet. Same 404-not-403 rule as elsewhere:
 * a service you cannot see should not be distinguishable from one that does
 * not exist.
 */
function requireServicePermission(permission: Parameters<typeof requireFleetPermission>[0]) {
  return async function guard(req: Parameters<ReturnType<typeof requireFleetPermission>>[0], reply: Parameters<ReturnType<typeof requireFleetPermission>>[1]) {
    const { serviceId } = req.params as { serviceId?: string }
    if (!serviceId) throw ApiError.badRequest('missing_service', 'Route is missing a service id')

    const rows = await req.server.ctx.db
      .select({ fleetId: services.fleetId })
      .from(services)
      .where(eq(services.id, serviceId))
      .limit(1)
    if (!rows[0]) throw ApiError.notFound('Service')

    // Reuse the fleet guard by supplying the fleet the service belongs to.
    ;(req.params as Record<string, string>).fleetId = rows[0].fleetId
    await requireFleetPermission(permission)(req, reply)
  }
}

async function loadService(app: FastifyInstance, params: { serviceId: string }) {
  const rows = await app.ctx.db
    .select({ service: services, orgId: fleets.orgId })
    .from(services)
    .innerJoin(fleets, eq(fleets.id, services.fleetId))
    .where(eq(services.id, params.serviceId))
    .limit(1)
  if (!rows[0]) throw ApiError.notFound('Service')
  return { service: rows[0].service, fleetId: rows[0].service.fleetId, orgId: rows[0].orgId }
}
