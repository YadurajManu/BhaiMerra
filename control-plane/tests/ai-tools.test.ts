/**
 * The read-only view a diagnosis is built on.
 *
 * Each of these is a query somebody ran by hand while working out why a
 * service was down. They are tested against a real database rather than a
 * mock, because what makes them useful is exactly what a mock would invent:
 * that a deployment's failure reason is where the cause usually is, that a
 * node's own heartbeat disagrees with the control plane when something has
 * gone wrong, that a service with no live deployment has no log to read.
 */
import 'dotenv/config'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { loadConfig } from '../src/config.js'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { deployments, fleets, nodes, orgs, services } from '../src/db/schema.js'
import { hashToken, newAgentToken } from '../src/lib/tokens.js'
import { callTool } from '../src/ai/tools.js'

let ctx: AppContext
let fleetId: string
let otherFleetId: string
/** Hostnames are unique across the whole table, and this database is not reset
    between runs — a fixed one works exactly once and then fails for ever. */
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

before(async () => {
  ctx = createContext(loadConfig())

  const [org] = await ctx.db.insert(orgs).values({ name: `tools-org-${Date.now()}` }).returning()
  const [fleet] = await ctx.db.insert(fleets).values({ orgId: org!.id, name: 'tools' }).returning()
  const [other] = await ctx.db.insert(fleets).values({ orgId: org!.id, name: 'other' }).returning()
  fleetId = fleet!.id
  otherFleetId = other!.id

  const [node] = await ctx.db
    .insert(nodes)
    .values({
      fleetId, name: 'box-1', arch: 'amd64', cpuCores: 4, ramMb: 8192, diskMb: 100_000,
      agentTokenHash: hashToken(newAgentToken()), status: 'online', agentVersion: '0.2.2',
    })
    .returning()

  const [svc] = await ctx.db
    .insert(services)
    .values({
      fleetId, name: 'api', project: 'demo', placementPolicy: 'flexible',
      requestRamMb: 512, compatibleArches: ['amd64'], hostname: `api-${runId}.example.invalid`,
    })
    .returning()

  // One failure and one success, so "how did it end" has something to say.
  await ctx.db.insert(deployments).values([
    {
      serviceId: svc!.id, nodeId: node!.id, status: 'failed',
      failureReason: 'the container is restarting and never reported healthy within the rollout window',
      startedAt: new Date(Date.now() - 600_000), finishedAt: new Date(Date.now() - 590_000),
    },
    { serviceId: svc!.id, nodeId: node!.id, status: 'running', startedAt: new Date(Date.now() - 60_000) },
  ])

  // A service in another fleet, to prove scoping.
  await ctx.db.insert(services).values({
    fleetId: otherFleetId, name: 'secret-api', project: 'other', placementPolicy: 'flexible',
    requestRamMb: 512, compatibleArches: ['amd64'],
  })
})

after(async () => {
  await closeContext(ctx)
})

describe('the tools a diagnosis can call', () => {
  test('services lists what is in the fleet, with how each stands', async () => {
    const out = await callTool(ctx, fleetId, 'services', {})
    assert.ok(out.ok)
    const rows = out.data as Array<{ service: string; status: string }>
    assert.deepEqual(rows.map((r) => r.service), ['api'])
    assert.equal(rows[0]!.status, 'running')
  })

  test('deployments carry the failure reason, which is usually the answer', async () => {
    const out = await callTool(ctx, fleetId, 'deployments', { service: 'api' })
    assert.ok(out.ok)
    const rows = out.data as Array<{ status: string; failureReason: string | null }>
    assert.equal(rows[0]!.status, 'running', 'newest first')
    assert.match(rows[1]!.failureReason!, /never reported healthy/)
  })

  test('nodes report how long they have been quiet', async () => {
    // "Marked online but silent for nine minutes" was a real finding, and it
    // is invisible without the elapsed time beside the status.
    const out = await callTool(ctx, fleetId, 'nodes', {})
    assert.ok(out.ok)
    const rows = out.data as Array<{ node: string; status: string; agentVersion: string }>
    assert.equal(rows[0]!.node, 'box-1')
    assert.equal(rows[0]!.agentVersion, '0.2.2')
  })

  test('a tool cannot read another fleet', async () => {
    // Scoped at the boundary rather than by asking callers to filter, so no
    // amount of argument-shaping reaches somebody else's fleet.
    const out = await callTool(ctx, fleetId, 'deployments', { service: 'secret-api' })
    assert.equal(out.ok, false)
    if (!out.ok) assert.match(out.error, /no service named/)
  })

  test('an unknown tool says what there is instead of failing silently', async () => {
    const out = await callTool(ctx, fleetId, 'rm_rf', {})
    assert.equal(out.ok, false)
    if (!out.ok) {
      assert.match(out.error, /no tool named/)
      assert.match(out.error, /deployments/, 'and lists the real ones')
    }
  })

  test('a service with no live deployment says so rather than erroring', async () => {
    // "Nothing is running" is a finding, not a failure, and a tool that threw
    // here would end the diagnosis at its most interesting moment.
    const [idle] = await ctx.db
      .insert(services)
      .values({
        fleetId, name: 'idle', project: 'demo', placementPolicy: 'flexible',
        requestRamMb: 512, compatibleArches: ['amd64'],
      })
      .returning()
    assert.ok(idle)

    const out = await callTool(ctx, fleetId, 'logs', { service: 'idle' })
    assert.ok(out.ok)
    assert.match(JSON.stringify(out.data), /no live deployment/)
  })
})
