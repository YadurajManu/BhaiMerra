/**
 * Tenancy on the GitHub surface.
 *
 * The App's installation list is global to the App. Before this, every route
 * read that global list, so any signed-up user could enumerate every account
 * that had installed Fleet, browse their private repositories, and connect one
 * to a fleet of their own. These tests are written from the attacker's side:
 * org A is given a fleet and asked, in every way the API allows, to reach org
 * B's installation.
 *
 * They run offline. The App is configured here rather than in .env.test — that
 * file is untracked, so a test that depended on its contents would pass on one
 * machine and fail on the next — and its key path points at nothing, so
 * anything that would call GitHub throws locally instead. That is fine: every
 * check asserted here happens before the network.
 */
import 'dotenv/config'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'

import { loadConfig } from '../src/config.js'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { buildServer } from '../src/server.js'
import { orgs, users, githubInstallations, githubRepositories } from '../src/db/schema.js'
import {
  claimInstallation,
  requireOrgInstallation,
  orgInstallations,
  releaseInstallation,
  setInstallationSuspended,
  pruneRepositories,
} from '../src/github/installations.js'
import { beginInstall, redeemInstall, installUrl, dashboardReturn } from '../src/github/install-flow.js'
import { slugMismatch } from '../src/github/app.js'
import { ApiError } from '../src/api/errors.js'

type Tenant = { token: string; orgId: string; userId: string; fleetId: string }

describe('GitHub installations are owned by exactly one org', () => {
  let ctx: AppContext
  let app: FastifyInstance
  let alice: Tenant
  let mallory: Tenant

  /** Alice's installation, claimed properly. Mallory must never reach it. */
  const ALICE_INSTALLATION = '90000001'
  const MALLORY_INSTALLATION = '90000002'

  const signup = async (label: string): Promise<Tenant> => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: `${label}-${Date.now()}@example.test`, password: 'a-long-enough-password' },
    })
    assert.equal(res.statusCode, 201, res.body)
    const body = res.json()
    return { token: body.accessToken, orgId: body.org.id, userId: body.user.id, fleetId: body.fleet.id }
  }

  before(async () => {
    ctx = createContext(
      loadConfig({
        ...process.env,
        GITHUB_APP_ID: 'test-app-id',
        GITHUB_APP_SLUG: 'fleet-os-test',
        GITHUB_APP_PRIVATE_KEY_PATH: '/nonexistent/fleet-os-test-key.pem',
      })
    )
    app = await buildServer(ctx)
    alice = await signup('alice')
    mallory = await signup('mallory')

    await claimInstallation(ctx, {
      orgId: alice.orgId,
      installationId: ALICE_INSTALLATION,
      account: 'alice-co',
      accountType: 'Organization',
      userId: alice.userId,
    })
    await claimInstallation(ctx, {
      orgId: mallory.orgId,
      installationId: MALLORY_INSTALLATION,
      account: 'mallory',
      userId: mallory.userId,
    })
  })

  after(async () => {
    await app.close()
    for (const t of [alice, mallory]) {
      await ctx.db.delete(orgs).where(eq(orgs.id, t.orgId))
      await ctx.db.delete(users).where(eq(users.id, t.userId))
    }
    await closeContext(ctx)
  })

  const as = (t: Tenant) => ({ headers: { authorization: `Bearer ${t.token}` } })

  /* ── the claim itself ────────────────────────────────────────────── */

  test('a second org cannot claim an installation that is already claimed', async () => {
    await assert.rejects(
      () =>
        claimInstallation(ctx, {
          orgId: mallory.orgId,
          installationId: ALICE_INSTALLATION,
          account: 'alice-co',
          userId: mallory.userId,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError)
        assert.equal(err.statusCode, 409)
        assert.equal(err.code, 'installation_claimed')
        return true
      }
    )

    // And the original claim is untouched.
    const [row] = await ctx.db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, ALICE_INSTALLATION))
    assert.equal(row!.orgId, alice.orgId)
  })

  test('re-running the flow for your own installation is not an error', async () => {
    const again = await claimInstallation(ctx, {
      orgId: alice.orgId,
      installationId: ALICE_INSTALLATION,
      account: 'alice-co-renamed',
      accountType: 'Organization',
      userId: alice.userId,
    })
    assert.equal(again.account, 'alice-co-renamed')
    assert.equal((await orgInstallations(ctx, alice.orgId)).length, 1, 'must update, not duplicate')
  })

  test('requireOrgInstallation refuses another org, and says "not found"', async () => {
    // 404 and not 403: whether an installation exists at all is information
    // about a different tenant.
    await assert.rejects(
      () => requireOrgInstallation(ctx, mallory.orgId, ALICE_INSTALLATION),
      (err: unknown) => err instanceof ApiError && err.statusCode === 404
    )
    const mine = await requireOrgInstallation(ctx, alice.orgId, ALICE_INSTALLATION)
    assert.equal(mine.account, 'alice-co-renamed')
  })

  test('a suspended installation stops resolving until it is unsuspended', async () => {
    await setInstallationSuspended(ctx, ALICE_INSTALLATION, true)
    await assert.rejects(
      () => requireOrgInstallation(ctx, alice.orgId, ALICE_INSTALLATION),
      (err: unknown) => err instanceof ApiError && err.code === 'installation_suspended'
    )
    await setInstallationSuspended(ctx, ALICE_INSTALLATION, false)
    await requireOrgInstallation(ctx, alice.orgId, ALICE_INSTALLATION)
  })

  /* ── over HTTP, as the attacker ──────────────────────────────────── */

  test('status shows only your own org\'s installations', async () => {
    const mine = await app.inject({ method: 'GET', url: `/fleets/${alice.fleetId}/github/status`, ...as(alice) })
    assert.equal(mine.statusCode, 200, mine.body)
    const aliceBody = mine.json()
    assert.deepEqual(
      aliceBody.installations.map((i: { id: number }) => String(i.id)),
      [ALICE_INSTALLATION]
    )

    const theirs = await app.inject({
      method: 'GET',
      url: `/fleets/${mallory.fleetId}/github/status`,
      ...as(mallory),
    })
    const malloryBody = theirs.json()
    assert.deepEqual(
      malloryBody.installations.map((i: { id: number }) => String(i.id)),
      [MALLORY_INSTALLATION],
      "mallory must not see alice's installation"
    )
  })

  test('the catalog refuses an installation id belonging to another org', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/fleets/${mallory.fleetId}/github/catalog?installation=${ALICE_INSTALLATION}`,
      ...as(mallory),
    })
    // 404 from requireOrgInstallation, reached before any call to GitHub.
    assert.equal(res.statusCode, 404, res.body)
    assert.match(res.body, /installation/i)
  })

  test('connecting a repository through another org\'s installation is refused', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/fleets/${mallory.fleetId}/github/repositories`,
      ...as(mallory),
      payload: {
        installationId: Number(ALICE_INSTALLATION),
        fullName: 'alice-co/private-crown-jewels',
      },
    })
    assert.equal(res.statusCode, 404, res.body)

    const rows = await ctx.db
      .select()
      .from(githubRepositories)
      .where(eq(githubRepositories.fleetId, mallory.fleetId))
    assert.equal(rows.length, 0, 'nothing may be persisted on a refused connect')
  })

  test('a fleet you are not a member of is not reachable at all', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/fleets/${alice.fleetId}/github/status`,
      ...as(mallory),
    })
    assert.equal(res.statusCode, 404, res.body)
  })

  /* ── the install flow's nonce ────────────────────────────────────── */

  test('an install nonce identifies the org, and burns on use', async () => {
    const state = await beginInstall(ctx, {
      orgId: alice.orgId,
      fleetId: alice.fleetId,
      userId: alice.userId,
    })
    const first = await redeemInstall(ctx, state)
    assert.equal(first?.orgId, alice.orgId)

    // Replaying it must not re-claim anything.
    assert.equal(await redeemInstall(ctx, state), null)
    assert.equal(await redeemInstall(ctx, 'never-issued'), null)
    assert.equal(await redeemInstall(ctx, ''), null)
  })

  test('the setup callback refuses a claim it cannot tie to a nonce', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/github/setup?installation_id=90000099&setup_action=install&state=forged`,
    })
    assert.equal(res.statusCode, 302)
    assert.match(res.headers.location as string, /github=failed/)
    assert.match(res.headers.location as string, /expired_or_unrecognised_link/)

    const [claimed] = await ctx.db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, '90000099'))
    assert.equal(claimed, undefined, 'a forged state must claim nothing')
  })

  test('the install URL carries the state and points at the configured app', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/fleets/${alice.fleetId}/github/install-url`,
      ...as(alice),
    })
    assert.equal(res.statusCode, 200, res.body)
    const url = new URL(res.json().url)
    assert.equal(url.host, 'github.com')
    assert.equal(url.pathname, '/apps/fleet-os-test/installations/new')
    assert.ok(url.searchParams.get('state'), 'must carry a state')

    // And that state is live, tied to the caller's org.
    const intent = await redeemInstall(ctx, url.searchParams.get('state')!)
    assert.equal(intent?.orgId, alice.orgId)
  })

  /* ── revocation ──────────────────────────────────────────────────── */

  test('uninstalling releases the claim and every repository behind it', async () => {
    await ctx.db.insert(githubRepositories).values({
      fleetId: alice.fleetId,
      installationId: ALICE_INSTALLATION,
      account: 'alice-co',
      fullName: 'alice-co/app',
      cloneUrl: 'https://github.com/alice-co/app.git',
      defaultBranch: 'main',
      branch: 'main',
    })

    const result = await releaseInstallation(ctx, ALICE_INSTALLATION)
    assert.equal(result.repositories, 1)
    assert.equal(await orgInstallations(ctx, alice.orgId).then((r) => r.length), 0)

    // Crucially, a later re-install by someone else inherits nothing.
    await claimInstallation(ctx, {
      orgId: mallory.orgId,
      installationId: ALICE_INSTALLATION,
      account: 'alice-co',
      userId: mallory.userId,
    })
    const inherited = await ctx.db
      .select()
      .from(githubRepositories)
      .where(eq(githubRepositories.installationId, ALICE_INSTALLATION))
    assert.equal(inherited.length, 0)
    await releaseInstallation(ctx, ALICE_INSTALLATION)
  })

  test('narrowing an installation\'s repositories drops those connections', async () => {
    await claimInstallation(ctx, {
      orgId: alice.orgId,
      installationId: ALICE_INSTALLATION,
      account: 'alice-co',
      userId: alice.userId,
    })
    await ctx.db.insert(githubRepositories).values([
      {
        fleetId: alice.fleetId,
        installationId: ALICE_INSTALLATION,
        account: 'alice-co',
        fullName: 'alice-co/kept',
        cloneUrl: 'https://github.com/alice-co/kept.git',
        defaultBranch: 'main',
        branch: 'main',
      },
      {
        fleetId: alice.fleetId,
        installationId: ALICE_INSTALLATION,
        account: 'alice-co',
        fullName: 'alice-co/revoked',
        cloneUrl: 'https://github.com/alice-co/revoked.git',
        defaultBranch: 'main',
        branch: 'main',
      },
    ])

    assert.equal(await pruneRepositories(ctx, ALICE_INSTALLATION, ['alice-co/revoked']), 1)
    assert.equal(await pruneRepositories(ctx, ALICE_INSTALLATION, []), 0)

    const left = await ctx.db
      .select()
      .from(githubRepositories)
      .where(eq(githubRepositories.installationId, ALICE_INSTALLATION))
    assert.deepEqual(
      left.map((r) => r.fullName),
      ['alice-co/kept']
    )
  })
})

describe('install flow helpers', () => {
  test('the return URL cannot be steered by the caller', () => {
    // The setup callback is unauthenticated and GitHub redirects a browser
    // into it, so the Location it emits comes from configuration only.
    assert.equal(
      dashboardReturn({ PUBLIC_DASHBOARD_URL: 'https://fleet.example/' }, 'connected'),
      'https://fleet.example/settings?github=connected'
    )
    assert.equal(
      dashboardReturn({}, 'failed', 'expired_or_unrecognised_link'),
      '/settings?github=failed&reason=expired_or_unrecognised_link'
    )
  })

  test('no app slug is a clear configuration error, not a broken link', () => {
    assert.throws(
      () => installUrl({ appId: '1', privateKeyPath: '/dev/null' }, 'abc'),
      (err: unknown) => err instanceof ApiError && err.code === 'github_slug_missing'
    )
  })

  test('a slug naming a different App than the key is detected', () => {
    // The failure this prevents is nasty because every individual step
    // succeeds: the link opens, GitHub installs the App, and only the
    // callback fails — reporting an installation "this App cannot see",
    // which is true and completely unhelpful on its own.
    const key = { appId: '4709904', privateKeyPath: '/dev/null' }
    assert.equal(slugMismatch({ ...key, slug: 'pleasefleet' }, { slug: 'fleeos' }), true)
    assert.equal(slugMismatch({ ...key, slug: 'fleeos' }, { slug: 'fleeos' }), false)
    // GitHub lowercases slugs; a difference in case is not a mismatch.
    assert.equal(slugMismatch({ ...key, slug: 'FleeOS' }, { slug: 'fleeos' }), false)
    // No slug configured is a separate, already-reported problem.
    assert.equal(slugMismatch(key, { slug: 'fleeos' }), false)
  })

  test('a state with URL-significant bytes survives the round trip', () => {
    const url = new URL(installUrl({ appId: '1', privateKeyPath: '/dev/null', slug: 'my-app' }, 'a+b/c=d&e'))
    assert.equal(url.searchParams.get('state'), 'a+b/c=d&e')
  })
})
