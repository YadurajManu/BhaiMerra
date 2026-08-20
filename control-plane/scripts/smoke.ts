/**
 * End-to-end smoke test against a running control plane.
 *
 *   npm run smoke                 # assumes http://localhost:8080
 *   API=https://... npm run smoke
 *
 * Walks the whole Phase 1-2 path: sign up, pair three nodes, heartbeat, apply
 * a fleet.yaml, preview placement, deploy, inspect the placement map, then
 * kill a node and watch failover happen.
 */
import { readFileSync } from 'node:fs'

const API = process.env.API ?? 'http://localhost:8080'
const TIMEOUT_MS = 8000

let failures = 0
const ok = (label: string, detail = '') => console.log(`  ✓ ${label}${detail ? '  ' + detail : ''}`)
const bad = (label: string, detail = '') => {
  failures++
  console.log(`  ✗ ${label}${detail ? '  ' + detail : ''}`)
}
const section = (t: string) => console.log(`\n── ${t} ──`)
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function call<T = any>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {}
): Promise<{ status: number; body: T }> {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await res.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = text
  }
  return { status: res.status, body: parsed as T }
}

const MANIFEST = `
fleet: homelab
defaults:
  reclaim: idle
services:
  web:
    image: nginx:1.27
    placement: flexible
    resources: { ram: 512Mi, cpu: 0.5 }
    domain: web.yourdomain.dev
    anti_affinity: [img-proxy]
  img-proxy:
    image: darthsim/imgproxy:latest
    resources: { ram: 768Mi }
    arch: [amd64]
  postgres:
    image: postgres:16
    placement: pinned
    node: homeserver
    volume: pgdata
  metrics:
    image: prom/prometheus:latest
    volume: promdata
`

async function main() {
  section('health')
  const health = await call('GET', '/healthz')
  health.body.status === 'ok' ? ok('control plane up') : bad('control plane unhealthy', JSON.stringify(health.body))

  section('signup')
  const email = `smoke+${Date.now()}@fleet-os.dev`
  const signup = await call('POST', '/auth/signup', {
    body: { email, password: 'a sufficiently long passphrase' },
  })
  if (signup.status !== 201) return bad('signup', JSON.stringify(signup.body))
  const token: string = signup.body.accessToken
  const fleetId: string = signup.body.fleet.id
  ok('signed up', `fleet ${fleetId.slice(0, 8)}`)

  section('pair three nodes')
  const agents: Record<string, string> = {}
  for (const [name, arch, ramMb] of [
    ['pi5', 'arm64', 8192],
    ['homeserver', 'amd64', 16384],
    ['vpsfra', 'amd64', 2048],
  ] as const) {
    const pair = await call('POST', `/fleets/${fleetId}/nodes/pair-token`, { token })
    if (pair.status !== 201) return bad(`pair-token for ${name}`, JSON.stringify(pair.body))

    const reg = await call('POST', '/agent/register', {
      token: pair.body.token,
      body: { arch, cpu_cores: 4, ram_mb: ramMb, disk_mb: 100_000, hostname: name },
    })
    if (reg.status !== 201) return bad(`register ${name}`, JSON.stringify(reg.body))
    agents[reg.body.name] = reg.body.agent_token
    ok(`registered ${reg.body.name}`, `${arch} ${ramMb}MB`)
  }

  const beat = async (only?: string[]) => {
    for (const [name, agentToken] of Object.entries(agents)) {
      if (only && !only.includes(name)) continue
      await call('POST', '/agent/heartbeat', {
        token: agentToken,
        body: { cpu_pct: 18, ram_used_mb: 900, disk_used_mb: 12_000, mesh_connected: true },
      })
    }
  }
  await beat()
  ok('all three heartbeating')

  section('reject an invalid manifest')
  const invalid = await call('POST', `/fleets/${fleetId}/services/validate`, {
    token,
    body: { manifest: 'fleet: f\nservices:\n  web: { placement: pinned }\n  Bad_Name: { build: ./x }\n' },
  })
  invalid.body.valid === false && invalid.body.issues.length >= 3
    ? ok('rejected with every problem listed', `${invalid.body.issues.length} issues`)
    : bad('invalid manifest was not rejected properly', JSON.stringify(invalid.body))

  section('apply the manifest')
  const applied = await call('POST', `/fleets/${fleetId}/services`, { token, body: { manifest: MANIFEST } })
  if (applied.status !== 200) return bad('apply manifest', JSON.stringify(applied.body))
  ok('created', applied.body.created.join(', '))
  applied.body.warnings.some((w: string) => /Volumes do not move/.test(w))
    ? ok('FR-18 warning fired for the flexible service with a volume')
    : bad('expected an FR-18 warning for metrics')

  section('placement preview')
  const list = await call('GET', `/fleets/${fleetId}/services`, { token })
  const svc = (name: string) => list.body.services.find((s: any) => s.name === name)
  const preview = await call('GET', `/services/${svc('web').id}/placement-preview`, { token })
  const d = preview.body.decision
  if (d.outcome !== 'placed') return bad('web could not be placed', JSON.stringify(d))
  ok(`web would go to ${d.nodeName}`)
  for (const c of d.candidates) {
    console.log(
      `      ${c.nodeName.padEnd(12)} score=${c.score.toFixed(4)} free=${String(c.freeRamMb).padStart(5)}MB ` +
        `headroom=${c.breakdown.headroom.toFixed(3)} rel=${c.breakdown.reliability.toFixed(2)}`
    )
  }

  section('deploy everything')
  for (const s of list.body.services) {
    const res = await call('POST', `/services/${s.id}/deploy`, { token, body: { gitSha: '4f1c9ae' } })
    if (res.status === 201) ok(`${s.name} → ${res.body.placedOn.name}`, `score ${res.body.score}`)
    else bad(`${s.name}`, `${res.body.error?.code}: ${res.body.error?.message?.slice(0, 80)}`)
  }

  section('placement map')
  const map = await call('GET', `/fleets/${fleetId}/placement-map`, { token })
  for (const n of map.body.nodes) {
    console.log(
      `      ${n.name.padEnd(12)} ${String(n.status).padEnd(8)} ` +
        `${String(n.freeRamMb).padStart(5)}/${n.ramMb}MB free  ` +
        `[${n.services.map((s: any) => `${s.name}:${s.policy}`).join(' ') || '—'}]`
    )
  }

  section('a service that builds from source is honest about the missing runner')
  const noImage = await call('POST', `/fleets/${fleetId}/services`, {
    token,
    body: { manifest: 'fleet: homelab\nservices:\n  api: { build: ./apps/api }\n' },
  })
  if (noImage.status === 200) {
    const again = await call('GET', `/fleets/${fleetId}/services`, { token })
    const api = again.body.services.find((s: any) => s.name === 'api')
    const res = await call('POST', `/services/${api.id}/deploy`, { token })
    res.status === 501 && res.body.error.code === 'build_runner_unavailable'
      ? ok('returns 501 naming the gap, rather than pretending to deploy')
      : bad('expected 501 build_runner_unavailable', JSON.stringify(res.body).slice(0, 120))
  }

  section('failover: homeserver goes dark')
  const before = await call('GET', `/fleets/${fleetId}/placement-map`, { token })
  const hadOnHome = before.body.nodes.find((n: any) => n.name === 'homeserver').services.map((s: any) => s.name)
  console.log(`      homeserver was running: ${hadOnHome.join(', ')}`)

  // Everyone except homeserver keeps beating.
  const survivors = Object.keys(agents).filter((n) => n !== 'homeserver')
  const deadline = Date.now() + 45_000
  let moved = false
  while (Date.now() < deadline && !moved) {
    await beat(survivors)
    await wait(2000)
    const map2 = await call('GET', `/fleets/${fleetId}/placement-map`, { token })
    const home = map2.body.nodes.find((n: any) => n.name === 'homeserver')
    if (home.status === 'offline') {
      const stillThere = home.services.map((s: any) => s.name)
      const flexibleGone = !stillThere.includes('web') && !stillThere.includes('img-proxy')
      if (flexibleGone) {
        moved = true
        ok('homeserver marked offline and its flexible services moved')
        for (const n of map2.body.nodes) {
          console.log(
            `      ${n.name.padEnd(12)} ${String(n.status).padEnd(8)} ` +
              `[${n.services.map((s: any) => `${s.name}:${s.policy}`).join(' ') || '—'}]`
          )
        }
        const pinnedHeld = stillThere.includes('postgres')
        pinnedHeld
          ? ok('FR-7: postgres stayed on the dead node, as pinned services must')
          : bad('FR-7: the pinned service moved, which it must never do')
      }
    }
  }
  if (!moved) bad('failover did not complete within 45s')

  section('event timeline')
  const events = await call('GET', `/fleets/${fleetId}/events`, { token })
  for (const e of events.body.events.slice(0, 6)) {
    console.log(`      ${e.service.padEnd(10)} ${e.reason.padEnd(9)} ${e.from ?? '—'} → ${e.to ?? '—'}`)
  }
  events.body.events.some((e: any) => e.reason === 'failover')
    ? ok('a failover event is on the timeline')
    : bad('no failover event recorded')

  console.log(`\n${failures === 0 ? '✓ smoke passed' : `✗ ${failures} check(s) failed`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\nsmoke aborted:', err)
  process.exit(1)
})
