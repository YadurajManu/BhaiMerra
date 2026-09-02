/**
 * Closing an account.
 *
 * The whole point of these tests is what must NOT be destroyed: an org with
 * another owner, an account still inside its grace period, and anything at all
 * before the confirmation link is redeemed. The destructive path is one
 * statement; everything else exists to keep it from running by accident.
 */
import 'dotenv/config'
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { eq, inArray } from 'drizzle-orm'

import { loadConfig } from '../src/config.js'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { users, orgs, orgMembers, fleets, services, nodes } from '../src/db/schema.js'
import {
  deletionImpact,
  scheduleDeletion,
  cancelDeletion,
  runDueDeletions,
  GRACE_DAYS,
} from '../src/auth/account-deletion.js'
import { deletionScheduledEmail, deletionCompleteEmail } from '../src/email/templates.js'
import { runJanitor, JANITOR_INTERVAL_MS } from '../src/janitor.js'

let ctx: AppContext
let ownerId: string
let coOwnerId: string
let soloOrgId: string
let sharedOrgId: string
const made: { users: string[]; orgs: string[] } = { users: [], orgs: [] }

async function makeUser(tag: string) {
  const [u] = await ctx.db
    .insert(users)
    .values({ email: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`, passwordHash: 'x' })
    .returning()
  made.users.push(u!.id)
  return u!.id
}

before(async () => {
  ctx = createContext(loadConfig())
})

beforeEach(async () => {
  ownerId = await makeUser('owner')
  coOwnerId = await makeUser('coowner')

  // An org this person alone owns, with real infrastructure under it.
  const [solo] = await ctx.db.insert(orgs).values({ name: 'solo org' }).returning()
  soloOrgId = solo!.id
  made.orgs.push(soloOrgId)
  await ctx.db.insert(orgMembers).values({ orgId: soloOrgId, userId: ownerId, role: 'owner' })
  const [f] = await ctx.db.insert(fleets).values({ orgId: soloOrgId, name: 'homelab' }).returning()
  await ctx.db.insert(nodes).values({
    fleetId: f!.id, name: 'pi', arch: 'arm64',
    cpuCores: 4, ramMb: 4096, diskMb: 32768, agentTokenHash: 'test-hash',
  } as never)
  await ctx.db.insert(services).values({ fleetId: f!.id, name: 'web' } as never)

  // An org with a second owner, which must survive.
  const [shared] = await ctx.db.insert(orgs).values({ name: 'shared org' }).returning()
  sharedOrgId = shared!.id
  made.orgs.push(sharedOrgId)
  await ctx.db.insert(orgMembers).values([
    { orgId: sharedOrgId, userId: ownerId, role: 'owner' },
    { orgId: sharedOrgId, userId: coOwnerId, role: 'owner' },
  ])
  await ctx.db.insert(fleets).values({ orgId: sharedOrgId, name: 'shared-fleet' })
})

after(async () => {
  if (made.orgs.length) await ctx.db.delete(orgs).where(inArray(orgs.id, made.orgs))
  if (made.users.length) await ctx.db.delete(users).where(inArray(users.id, made.users))
  await closeContext(ctx)
})

describe('what closing an account would destroy', () => {
  test('counts the infrastructure under an org they alone own', async () => {
    const impact = await deletionImpact(ctx, ownerId)
    const solo = impact.find((o) => o.orgId === soloOrgId)!
    assert.equal(solo.fate, 'deleted')
    assert.equal(solo.fleets, 1)
    assert.equal(solo.nodes, 1)
    assert.equal(solo.services, 1)
  })

  test('marks an org with another owner as kept', async () => {
    // Deleting shared infrastructure because one member closed their account
    // would be indefensible.
    const impact = await deletionImpact(ctx, ownerId)
    const shared = impact.find((o) => o.orgId === sharedOrgId)!
    assert.equal(shared.fate, 'kept')
    assert.equal(shared.fleets, 0, 'nothing under a kept org is counted as doomed')
  })
})

describe('the grace period', () => {
  test('scheduling destroys nothing', async () => {
    await scheduleDeletion(ctx, ownerId)

    const [stillThere] = await ctx.db.select().from(users).where(eq(users.id, ownerId))
    assert.ok(stillThere, 'the account still exists')
    assert.ok(stillThere!.deletionScheduledFor, 'and is scheduled')

    const orgStill = await ctx.db.select().from(orgs).where(eq(orgs.id, soloOrgId))
    assert.equal(orgStill.length, 1, 'the org is untouched')
  })

  test('schedules roughly GRACE_DAYS out', async () => {
    const due = await scheduleDeletion(ctx, ownerId)
    const days = (due.getTime() - Date.now()) / 86_400_000
    assert.ok(Math.abs(days - GRACE_DAYS) < 0.01, `expected ~${GRACE_DAYS} days, got ${days}`)
  })

  test('an account inside its grace period is not touched by the sweeper', async () => {
    await scheduleDeletion(ctx, ownerId)
    const done = await runDueDeletions(ctx)
    assert.ok(!done.some((d) => d.userId === ownerId), 'not yet due')

    const [still] = await ctx.db.select().from(users).where(eq(users.id, ownerId))
    assert.ok(still, 'still there')
  })

  test('cancelling clears the schedule', async () => {
    await scheduleDeletion(ctx, ownerId)
    assert.equal(await cancelDeletion(ctx, ownerId), true)

    const [u] = await ctx.db.select().from(users).where(eq(users.id, ownerId))
    assert.equal(u!.deletionScheduledFor, null)
    assert.equal(u!.deletionRequestedAt, null)

    const done = await runDueDeletions(ctx)
    assert.ok(!done.some((d) => d.userId === ownerId), 'a cancelled account is never collected')
  })

  test('cancelling when nothing was scheduled reports false rather than throwing', async () => {
    assert.equal(await cancelDeletion(ctx, ownerId), false)
  })
})

describe('executing a due deletion', () => {
  test('removes the account and the orgs it alone owned', async () => {
    await ctx.db
      .update(users)
      .set({ deletionScheduledFor: new Date(Date.now() - 1000) })
      .where(eq(users.id, ownerId))

    const done = await runDueDeletions(ctx)
    assert.ok(done.some((d) => d.userId === ownerId))

    const gone = await ctx.db.select().from(users).where(eq(users.id, ownerId))
    assert.equal(gone.length, 0, 'the account is gone')

    const soloGone = await ctx.db.select().from(orgs).where(eq(orgs.id, soloOrgId))
    assert.equal(soloGone.length, 0, 'the org they alone owned is gone')

    // The cascade should have taken the fleet with it.
    const orphanFleets = await ctx.db.select().from(fleets).where(eq(fleets.orgId, soloOrgId))
    assert.equal(orphanFleets.length, 0, 'no orphaned fleets left behind')
  })

  test('leaves the shared org and its co-owner alone', async () => {
    await ctx.db
      .update(users)
      .set({ deletionScheduledFor: new Date(Date.now() - 1000) })
      .where(eq(users.id, ownerId))
    await runDueDeletions(ctx)

    const shared = await ctx.db.select().from(orgs).where(eq(orgs.id, sharedOrgId))
    assert.equal(shared.length, 1, 'the shared org survives')

    const co = await ctx.db.select().from(users).where(eq(users.id, coOwnerId))
    assert.equal(co.length, 1, 'the other owner still has an account')

    const stillMembers = await ctx.db
      .select()
      .from(orgMembers)
      .where(eq(orgMembers.orgId, sharedOrgId))
    assert.equal(stillMembers.length, 1, 'only the departing member was removed')
  })

  test('an account with no schedule is never collected', async () => {
    const done = await runDueDeletions(ctx)
    assert.ok(!done.some((d) => d.userId === ownerId))
    assert.equal((await ctx.db.select().from(users).where(eq(users.id, ownerId))).length, 1)
  })
})

describe('the emails', () => {
  test('the scheduled notice lists exactly what goes and what stays', () => {
    const { body, subject } = deletionScheduledEmail(
      new Date('2026-09-09T10:00:00Z'),
      [
        { name: 'solo org', fate: 'deleted', fleets: 1, nodes: 3, services: 4 },
        { name: 'shared org', fate: 'kept', fleets: 0, nodes: 0, services: 0 },
      ],
      'https://app.example.com'
    )
    assert.match(subject, /2026-09-09/)
    assert.ok(body.includes('solo org'))
    assert.ok(body.includes('3 nodes'))
    assert.ok(body.includes('4 services'))
    assert.ok(body.includes('kept - another owner remains'))
    // Nodes keep running whatever they are running. Saying so is the
    // difference between a tidy exit and a mystery container next month.
    assert.ok(body.includes('unpair'))
  })

  test('the scheduled notice explains how to stop it', () => {
    const { body } = deletionScheduledEmail(new Date(), [], 'https://app.example.com')
    assert.ok(body.includes('cancel'))
    assert.ok(body.includes('Nothing has been deleted'))
  })

  test('the final notice does not claim orgs were deleted when none were', () => {
    assert.ok(deletionCompleteEmail(0).body.includes('another owner were left in place'))
    assert.ok(deletionCompleteEmail(2).body.includes('2 organisations'))
    assert.ok(deletionCompleteEmail(1).body.includes('1 organisation,'))
  })
})

describe('the janitor, which is what actually runs in production', () => {
  test('deletes a due account and emails the address before it is gone', async () => {
    // The previous suite proves runDueDeletions works. This proves the thing
    // that CALLS it works, including the closure email - the wiring was the
    // untested half, and it is the half nobody notices is broken until an
    // account quietly fails to close.
    const sent: Array<{ to: string; subject: string; body: string }> = []
    const spy = { ...ctx, email: { async send(to: string, subject: string, body: string) {
      sent.push({ to, subject, body })
    } } } as AppContext

    const [u] = await ctx.db.select({ email: users.email }).from(users).where(eq(users.id, ownerId))
    await ctx.db
      .update(users)
      .set({ deletionScheduledFor: new Date(Date.now() - 1000) })
      .where(eq(users.id, ownerId))

    const result = await runJanitor(spy)

    assert.equal(result.accountsDeleted, 1)
    assert.equal(result.closureEmailsSent, 1)
    assert.equal(sent.length, 1)
    assert.equal(sent[0]!.to, u!.email, 'addressed to the account that closed')
    assert.match(sent[0]!.subject, /has been closed/)
    assert.match(sent[0]!.body, /last email/)

    assert.equal((await ctx.db.select().from(users).where(eq(users.id, ownerId))).length, 0)
  })

  test('a failing mail provider does not undo the deletion', async () => {
    // Deletion already happened when the send is attempted. Rolling it back on
    // an SMTP hiccup would leave an account the owner believes is closed.
    const angry = { ...ctx, email: { async send() { throw new Error('provider down') } } } as AppContext
    await ctx.db
      .update(users)
      .set({ deletionScheduledFor: new Date(Date.now() - 1000) })
      .where(eq(users.id, ownerId))

    const result = await runJanitor(angry, {
      info: () => {}, warn: () => {}, error: () => {},
    })

    assert.equal(result.accountsDeleted, 1)
    assert.equal(result.closureEmailsSent, 0, 'the send failed')
    assert.equal(
      (await ctx.db.select().from(users).where(eq(users.id, ownerId))).length,
      0,
      'but the account is still gone'
    )
  })

  test('a quiet tick touches nothing', async () => {
    const result = await runJanitor(ctx)
    assert.equal(result.accountsDeleted, 0)
    assert.equal((await ctx.db.select().from(users).where(eq(users.id, ownerId))).length, 1)
  })

  test('runs hourly, not on the heartbeat clock', () => {
    assert.equal(JANITOR_INTERVAL_MS, 60 * 60_000)
  })
})
