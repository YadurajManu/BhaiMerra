import { and, eq, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm'
import { users, orgs, orgMembers, fleets, nodes, services } from '../db/schema.js'
import type { AppContext } from '../api/context.js'

/**
 * Closing an account.
 *
 * The destructive part is one statement — deleting an org cascades to its
 * fleets, and a fleet cascades to its nodes, services, deployments, secrets and
 * backups. Everything else in this file exists to make sure that statement only
 * runs when the person who owns the account genuinely meant it.
 *
 * Three gates, and each closes a different hole:
 *
 *   - the password, so a borrowed session cannot start it;
 *   - a token mailed to the address on file, so starting it is not enough;
 *   - a grace period, so even both of those together give the real owner time
 *     to notice and call it off.
 */

/** Long enough to notice an email, short enough not to feel like a trap. */
export const GRACE_DAYS = 7

export type OrgFate = {
  orgId: string
  name: string
  /** Deleted outright, or kept because somebody else owns it too. */
  fate: 'deleted' | 'kept'
  fleets: number
  nodes: number
  services: number
}

/**
 * What closing this account would actually destroy.
 *
 * Shown before confirming and repeated in every email. "Your account will be
 * deleted" is not informed consent when the real consequence is four fleets and
 * eleven services.
 */
export async function deletionImpact(ctx: AppContext, userId: string): Promise<OrgFate[]> {
  const memberships = await ctx.db
    .select({ orgId: orgMembers.orgId, name: orgs.name, role: orgMembers.role })
    .from(orgMembers)
    .innerJoin(orgs, eq(orgs.id, orgMembers.orgId))
    .where(eq(orgMembers.userId, userId))

  const out: OrgFate[] = []
  for (const m of memberships) {
    // An org with another owner survives: this person leaves, the org does not
    // die with them. Deleting shared infrastructure because one member closed
    // their account would be indefensible.
    const [others] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(orgMembers)
      .where(
        and(
          eq(orgMembers.orgId, m.orgId),
          eq(orgMembers.role, 'owner'),
          ne(orgMembers.userId, userId)
        )
      )
    const soleOwner = m.role === 'owner' && (others?.n ?? 0) === 0

    const fleetRows = await ctx.db
      .select({ id: fleets.id })
      .from(fleets)
      .where(eq(fleets.orgId, m.orgId))
    const fleetIds = fleetRows.map((f) => f.id)

    const countIn = async (table: typeof nodes | typeof services) => {
      if (!fleetIds.length) return 0
      const [r] = await ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(table)
        .where(inArray(table.fleetId, fleetIds))
      return r?.n ?? 0
    }

    out.push({
      orgId: m.orgId,
      name: m.name,
      fate: soleOwner ? 'deleted' : 'kept',
      fleets: soleOwner ? fleetIds.length : 0,
      nodes: soleOwner ? await countIn(nodes) : 0,
      services: soleOwner ? await countIn(services) : 0,
    })
  }
  return out
}

/** Mark the request. Nothing is destroyed and the account keeps working. */
export async function requestDeletion(ctx: AppContext, userId: string): Promise<void> {
  await ctx.db
    .update(users)
    .set({ deletionRequestedAt: new Date() })
    .where(eq(users.id, userId))
}

/** Confirm, and start the clock. Returns the moment it becomes irreversible. */
export async function scheduleDeletion(ctx: AppContext, userId: string): Promise<Date> {
  const due = new Date(Date.now() + GRACE_DAYS * 24 * 60 * 60_000)
  await ctx.db.update(users).set({ deletionScheduledFor: due }).where(eq(users.id, userId))
  return due
}

/** Call it off. Safe to run when nothing was scheduled. */
export async function cancelDeletion(ctx: AppContext, userId: string): Promise<boolean> {
  const rows = await ctx.db
    .update(users)
    .set({ deletionScheduledFor: null, deletionRequestedAt: null })
    .where(and(eq(users.id, userId), isNotNull(users.deletionScheduledFor)))
    .returning({ id: users.id })
  return rows.length > 0
}

export type Executed = { userId: string; email: string; orgsDeleted: number }

/**
 * Perform every deletion whose grace period has run out.
 *
 * Orgs go first and explicitly rather than relying on the user cascade, because
 * a user is not the parent of an org — org_members is — so deleting the user
 * alone would leave the org, its fleets and its services orphaned and
 * unreachable forever.
 */
export async function runDueDeletions(
  ctx: AppContext,
  log?: { info: (o: unknown, m: string) => void }
): Promise<Executed[]> {
  const due = await ctx.db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(and(isNotNull(users.deletionScheduledFor), lte(users.deletionScheduledFor, new Date())))

  const done: Executed[] = []
  for (const u of due) {
    const impact = await deletionImpact(ctx, u.id)
    const doomed = impact.filter((o) => o.fate === 'deleted').map((o) => o.orgId)

    await ctx.db.transaction(async (tx) => {
      if (doomed.length) await tx.delete(orgs).where(inArray(orgs.id, doomed))
      await tx.delete(users).where(eq(users.id, u.id))
    })

    log?.info({ userId: u.id, orgs: doomed.length }, 'account deleted after grace period')
    done.push({ userId: u.id, email: u.email, orgsDeleted: doomed.length })
  }
  return done
}
