import { and, eq, inArray } from 'drizzle-orm'
import { githubInstallations, githubRepositories, fleets } from '../db/schema.js'
import { listRepos, type GitHubConfig } from './app.js'
import { ApiError } from '../api/errors.js'
import type { AppContext } from '../api/context.js'

/**
 * Ownership of GitHub App installations.
 *
 * A GitHub App has one installation list, shared by every tenant of the
 * control plane that runs it. Nothing in that list says which org installed
 * what, so every lookup has to be filtered through this table before it is
 * allowed to influence a clone, a token, or a repository listing.
 *
 * The rule is one line: an org may only ever act on installations it has
 * claimed. Everything here exists to make that rule hard to route around.
 */

export type InstallationRow = typeof githubInstallations.$inferSelect

/** Every installation this org has claimed, newest first. */
export async function orgInstallations(ctx: AppContext, orgId: string): Promise<InstallationRow[]> {
  const rows = await ctx.db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.orgId, orgId))
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
}

/**
 * Bind an installation to an org.
 *
 * Claiming is first-come and exclusive. Two orgs sharing one installation
 * would mean either could read the other's repositories through it, so the
 * second claim is refused rather than merged — and refused with a message
 * that says what actually happened, because the usual cause is a person with
 * two accounts, not an attack.
 */
export async function claimInstallation(
  ctx: AppContext,
  params: {
    orgId: string
    installationId: string
    account: string
    accountType?: string
    userId?: string | null
  }
): Promise<InstallationRow> {
  const [existing] = await ctx.db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, params.installationId))
    .limit(1)

  if (existing) {
    if (existing.orgId !== params.orgId) {
      throw new ApiError(
        409,
        'installation_claimed',
        `The GitHub account "${params.account}" is already connected to a different Fleet organisation. ` +
          `Uninstall the app from that account, or disconnect it there first.`
      )
    }
    // Re-running the install flow refreshes the account name and lifts a
    // suspension; it is not an error.
    const [updated] = await ctx.db
      .update(githubInstallations)
      .set({
        account: params.account,
        accountType: params.accountType ?? existing.accountType,
        suspendedAt: null,
      })
      .where(eq(githubInstallations.id, existing.id))
      .returning()
    return updated!
  }

  const [created] = await ctx.db
    .insert(githubInstallations)
    .values({
      orgId: params.orgId,
      installationId: params.installationId,
      account: params.account,
      accountType: params.accountType ?? 'User',
      connectedByUserId: params.userId ?? null,
    })
    .returning()
  return created!
}

/**
 * The gate every GitHub route goes through: resolve an installation id, but
 * only within the caller's org.
 *
 * 404 rather than 403 for an installation belonging to someone else — the
 * existence of another org's installation is itself information.
 */
export async function requireOrgInstallation(
  ctx: AppContext,
  orgId: string,
  installationId: string | number
): Promise<InstallationRow> {
  const [row] = await ctx.db
    .select()
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.orgId, orgId),
        eq(githubInstallations.installationId, String(installationId))
      )
    )
    .limit(1)

  if (!row) throw ApiError.notFound('GitHub installation')
  if (row.suspendedAt) {
    throw new ApiError(
      409,
      'installation_suspended',
      `GitHub has suspended Fleet's access to "${row.account}". Re-enable it in that account's ` +
        `installation settings.`
    )
  }
  return row
}

/**
 * Which of *this org's* installations can reach a repository.
 *
 * The unscoped version of this — walk every installation until one matches —
 * is what let a service point at a stranger's private repo and have Fleet
 * clone it with the stranger's token. Restricting the search to claimed
 * installations is the whole fix.
 */
export async function installationForRepoInOrg(
  ctx: AppContext,
  config: GitHubConfig,
  orgId: string,
  repoFullName: string
): Promise<number | null> {
  const wanted = repoFullName.toLowerCase()
  for (const row of await orgInstallations(ctx, orgId)) {
    if (row.suspendedAt) continue
    const id = Number(row.installationId)
    if (!Number.isFinite(id)) continue
    // One bad installation must not hide a good one behind it.
    let repos: Awaited<ReturnType<typeof listRepos>>
    try {
      repos = await listRepos(config, id)
    } catch {
      continue
    }
    if (repos.some((r) => r.full_name.toLowerCase() === wanted)) return id
  }
  return null
}

/**
 * How many of the App's live installations no org has claimed.
 *
 * The binding only happens when GitHub redirects to the setup callback, and it
 * only does that if the App has a Setup URL configured. Forget that field and
 * every install silently succeeds on GitHub and connects nothing here — no
 * error, no log line, an unchanged dashboard. This count is what makes that
 * visible.
 *
 * A count and never the accounts: which GitHub accounts exist on this control
 * plane is another tenant's business.
 */
export async function countUnclaimed(ctx: AppContext, liveIds: string[]): Promise<number> {
  if (!liveIds.length) return 0
  const claimed = await ctx.db
    .select({ installationId: githubInstallations.installationId })
    .from(githubInstallations)
    .where(inArray(githubInstallations.installationId, liveIds))
  const seen = new Set(claimed.map((row) => row.installationId))
  return liveIds.filter((id) => !seen.has(id)).length
}

/**
 * The org an installation belongs to, or null if nobody has claimed it.
 *
 * This is how an app-wide webhook — which knows only an installation id —
 * finds out whose event it is holding.
 */
export async function orgForInstallation(
  ctx: AppContext,
  installationId: string
): Promise<InstallationRow | null> {
  const [row] = await ctx.db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId))
    .limit(1)
  return row ?? null
}

/** Every repository connected in any fleet of an org. */
export async function orgRepositories(
  ctx: AppContext,
  orgId: string
): Promise<Array<typeof githubRepositories.$inferSelect>> {
  const rows = await ctx.db
    .select({ repo: githubRepositories })
    .from(githubRepositories)
    .innerJoin(fleets, eq(fleets.id, githubRepositories.fleetId))
    .where(eq(fleets.orgId, orgId))
  return rows.map((r) => r.repo)
}

/** The org that owns a fleet, for the paths that only have a fleet id. */
export async function orgForFleet(ctx: AppContext, fleetId: string): Promise<string | null> {
  const [row] = await ctx.db
    .select({ orgId: fleets.orgId })
    .from(fleets)
    .where(eq(fleets.id, fleetId))
    .limit(1)
  return row?.orgId ?? null
}

/**
 * Forget an installation and every repository connection that depended on it.
 *
 * Called when GitHub says the app was uninstalled. Leaving the connections
 * behind would leave rows that look live in the dashboard but can no longer
 * mint a token, and would let a later re-install by *another* org inherit
 * someone else's repository list.
 */
export async function releaseInstallation(
  ctx: AppContext,
  installationId: string
): Promise<{ repositories: number; installation: string | null }> {
  const removedRepos = await ctx.db
    .delete(githubRepositories)
    .where(eq(githubRepositories.installationId, installationId))
    .returning({ id: githubRepositories.id })

  const [removed] = await ctx.db
    .delete(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId))
    .returning({ account: githubInstallations.account })

  return { repositories: removedRepos.length, installation: removed?.account ?? null }
}

/** GitHub suspends without deleting; mirror that rather than losing the claim. */
export async function setInstallationSuspended(
  ctx: AppContext,
  installationId: string,
  suspended: boolean
): Promise<boolean> {
  const updated = await ctx.db
    .update(githubInstallations)
    .set({ suspendedAt: suspended ? new Date() : null })
    .where(eq(githubInstallations.installationId, installationId))
    .returning({ id: githubInstallations.id })
  return updated.length > 0
}

/**
 * Drop connections for repositories removed from an installation's grant.
 *
 * A user narrowing which repositories the App may see is revoking access; the
 * stored connection has to go with it or a later push would still be matched.
 */
export async function pruneRepositories(
  ctx: AppContext,
  installationId: string,
  fullNames: string[]
): Promise<number> {
  if (!fullNames.length) return 0
  const removed = await ctx.db
    .delete(githubRepositories)
    .where(
      and(
        eq(githubRepositories.installationId, installationId),
        inArray(githubRepositories.fullName, fullNames)
      )
    )
    .returning({ id: githubRepositories.id })
  return removed.length
}
