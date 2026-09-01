/**
 * Push deploys delivered to the App itself.
 *
 * The point of this endpoint is that connecting a repository in the dashboard
 * is the whole setup — no per-repository webhook, no secret pasted into a
 * GitHub settings page. That makes it the one URL every installed repository
 * pushes to, so what it declines to act on matters as much as what it deploys.
 *
 * None of these tests let a deploy actually start: each asserts the routing
 * decision, which the handler makes and reports before it hands off.
 */
import 'dotenv/config'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'

import { loadConfig } from '../src/config.js'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { buildServer } from '../src/server.js'
import { orgs, users, githubRepositories } from '../src/db/schema.js'
import { claimInstallation, orgRepositories } from '../src/github/installations.js'
import { pushTargets } from '../src/api/webhooks.routes.js'
import { repoCandidates, projectForRepo } from '../src/github/repo-url.js'

type Tenant = { token: string; orgId: string; userId: string; fleetId: string }

/** A repository both tenants happen to have connected. */
const SHARED_REPO = 'https://github.com/octo/shared.git'

describe('a push delivered to the App', () => {
  let ctx: AppContext
  let app: FastifyInstance
  let alice: Tenant
  let mallory: Tenant

  const ALICE_INSTALLATION = '91000001'
  const MALLORY_INSTALLATION = '91000002'
  const UNCLAIMED_INSTALLATION = '91000009'

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

  const push = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: { 'x-github-event': 'push', 'content-type': 'application/json' },
      payload,
    })

  /**
   * Every URL in the payload is derived from one name. A payload whose
   * clone_url and html_url disagree would match on whichever field happened to
   * be checked, which is a bug in the test rather than a scenario.
   */
  const pushBody = (opts: {
    installationId?: string
    ref?: string
    sha?: string
    fullName?: string
  }) => {
    const fullName = opts.fullName ?? 'octo/shared'
    return {
      ref: opts.ref ?? 'refs/heads/main',
      head_commit: { id: opts.sha ?? 'a'.repeat(40) },
      repository: {
        full_name: fullName,
        clone_url: `https://github.com/${fullName}.git`,
        html_url: `https://github.com/${fullName}`,
      },
      ...(opts.installationId ? { installation: { id: Number(opts.installationId) } } : {}),
    }
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
    alice = await signup('push-alice')
    mallory = await signup('push-mallory')

    await claimInstallation(ctx, {
      orgId: alice.orgId,
      installationId: ALICE_INSTALLATION,
      account: 'alice-co',
      userId: alice.userId,
    })
    await claimInstallation(ctx, {
      orgId: mallory.orgId,
      installationId: MALLORY_INSTALLATION,
      account: 'mallory',
      userId: mallory.userId,
    })

    // Both tenants connect the same public repository, each watching a
    // different branch, so a mix-up is visible rather than a coincidence.
    await ctx.db.insert(githubRepositories).values([
      {
        fleetId: alice.fleetId,
        installationId: ALICE_INSTALLATION,
        account: 'octo',
        fullName: 'octo/shared',
        cloneUrl: SHARED_REPO,
        defaultBranch: 'main',
        branch: 'main',
      },
      {
        fleetId: mallory.fleetId,
        installationId: MALLORY_INSTALLATION,
        account: 'octo',
        fullName: 'octo/shared',
        cloneUrl: SHARED_REPO,
        defaultBranch: 'main',
        branch: 'release',
      },
    ])
  })

  after(async () => {
    await app.close()
    for (const t of [alice, mallory]) {
      await ctx.db.delete(orgs).where(eq(orgs.id, t.orgId))
      await ctx.db.delete(users).where(eq(users.id, t.userId))
    }
    await closeContext(ctx)
  })

  test('a ping is answered without touching anything', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: { 'x-github-event': 'ping', 'content-type': 'application/json' },
      payload: { zen: 'Non-blocking is better than blocking.' },
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().pong, true)
  })

  test('a push with no installation is ignored', async () => {
    // Delivered to the App's URL but carrying nothing that says whose it is.
    // Guessing here is how tenancy holes are made.
    const res = await push(pushBody({}))
    assert.equal(res.statusCode, 200, res.body)
    assert.match(res.json().ignored, /no installation/i)
  })

  test('a push for an installation nobody has claimed is ignored', async () => {
    const res = await push(pushBody({ installationId: UNCLAIMED_INSTALLATION }))
    assert.equal(res.statusCode, 200, res.body)
    assert.match(res.json().ignored, /not connected to an organisation/i)
  })

  test('a branch deletion builds nothing', async () => {
    const res = await push(
      pushBody({ installationId: ALICE_INSTALLATION, sha: '0'.repeat(40) })
    )
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(res.json().ignored, 'branch deleted')
  })

  test('a push to an unwatched branch is ignored, and says which is watched', async () => {
    const res = await push(
      pushBody({ installationId: ALICE_INSTALLATION, ref: 'refs/heads/feature/x' })
    )
    assert.equal(res.statusCode, 200, res.body)
    const { ignored } = res.json()
    assert.match(ignored, /watching main/)
    assert.match(ignored, /feature\/x/)
  })

  test('a push for a repository connected to no fleet is ignored', async () => {
    const res = await push(
      pushBody({ installationId: ALICE_INSTALLATION, fullName: 'octo/unconnected' })
    )
    assert.equal(res.statusCode, 200, res.body)
    assert.match(res.json().ignored, /not connected to any fleet/i)
  })

  test("one org's push never reaches another org's fleets", async () => {
    // Both connected octo/shared. Alice watches main, Mallory watches release.
    // A push carrying Alice's installation must resolve to Alice's fleet only,
    // and must not deploy Mallory's — even though the repository matches.
    const aliceRepos = await orgRepositories(ctx, alice.orgId)
    const malloryRepos = await orgRepositories(ctx, mallory.orgId)

    assert.deepEqual(aliceRepos.map((r) => r.fleetId), [alice.fleetId])
    assert.deepEqual(malloryRepos.map((r) => r.fleetId), [mallory.fleetId])

    const candidates = repoCandidates({ full_name: 'octo/shared', clone_url: SHARED_REPO })
    assert.deepEqual(
      pushTargets(aliceRepos, candidates, 'refs/heads/main').map((r) => r.fleetId),
      [alice.fleetId]
    )
    // The same push against Mallory's connections matches nothing: she watches
    // release. This is what stops a shared repo cross-deploying.
    assert.deepEqual(pushTargets(malloryRepos, candidates, 'refs/heads/main'), [])
  })
})

describe('push routing', () => {
  const connections = [
    { cloneUrl: 'https://github.com/you/app.git', branch: 'main', fleetId: 'f1' },
    { cloneUrl: 'git@github.com:you/app.git', branch: 'staging', fleetId: 'f2' },
    { cloneUrl: 'https://github.com/you/other.git', branch: 'main', fleetId: 'f3' },
  ]
  const candidates = repoCandidates({
    full_name: 'you/app',
    clone_url: 'https://github.com/you/app.git',
  })

  test('matches the repository however it was written, and only that branch', () => {
    assert.deepEqual(
      pushTargets(connections, candidates, 'refs/heads/main').map((c) => c.fleetId),
      ['f1'],
      'the ssh spelling of the same repo is the same repo, but it watches staging'
    )
    assert.deepEqual(
      pushTargets(connections, candidates, 'refs/heads/staging').map((c) => c.fleetId),
      ['f2']
    )
  })

  test('one repository connected to several fleets deploys all of them', () => {
    const two = [
      { cloneUrl: 'https://github.com/you/app.git', branch: 'main', fleetId: 'a' },
      { cloneUrl: 'https://github.com/you/app', branch: 'main', fleetId: 'b' },
    ]
    assert.deepEqual(pushTargets(two, candidates, 'refs/heads/main').map((c) => c.fleetId), ['a', 'b'])
  })

  test('a tag push is not a branch push', () => {
    assert.deepEqual(pushTargets(connections, candidates, 'refs/tags/v1.0.0'), [])
  })

  test('a branch whose name contains the watched name does not match', () => {
    // "main" must not match "mainline"; the comparison is on the whole ref.
    assert.deepEqual(pushTargets(connections, candidates, 'refs/heads/mainline'), [])
  })
})

describe('repository naming', () => {
  test('a repository deploys into a project named after itself', () => {
    assert.equal(projectForRepo('https://github.com/YaduEnc/MuhDikhai.git'), 'muhdikhai')
    assert.equal(projectForRepo('git@github.com:you/my_app.git'), 'my-app')
    assert.equal(projectForRepo('you/repo'), 'repo')
  })
})
