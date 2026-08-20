/**
 * Full path: build from source → registry → schedule → agent pulls and runs
 * → the container actually serves traffic.
 *
 * Requires a running control plane, a running agent with Docker, and a
 * registry the control plane can push to and the agent can pull from.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const API = process.env.API ?? 'http://localhost:8080'
const AGENT_BIN = process.env.AGENT_BIN ?? '../agent/dist/fleet-agent'

let failures = 0
let agent: ChildProcess | null = null
const cleanup: Array<() => Promise<void>> = []
const ok = (m: string, d = '') => console.log(`  ✓ ${m}${d ? '  ' + d : ''}`)
const bad = (m: string, d = '') => { failures++; console.log(`  ✗ ${m}${d ? '  ' + d : ''}`) }
const section = (t: string) => console.log(`\n── ${t} ──`)
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function call<T = any>(method: string, path: string, o: { token?: string; body?: unknown } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
      ...(o.body ? { 'content-type': 'application/json' } : {}),
    },
    body: o.body ? JSON.stringify(o.body) : undefined,
    signal: AbortSignal.timeout(20 * 60_000),
  })
  const text = await res.text()
  let body: unknown
  try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body: body as T }
}

async function main() {
  section('sign up and pair this machine as a node')
  const signup = await call('POST', '/auth/signup', {
    body: { email: `e2e+${Date.now()}@fleet-os.dev`, password: 'a sufficiently long passphrase' },
  })
  if (signup.status !== 201) return bad('signup', JSON.stringify(signup.body))
  const token = signup.body.accessToken
  const fleetId = signup.body.fleet.id

  const pair = await call('POST', `/fleets/${fleetId}/nodes/pair-token`, { token })

  // Spawn a real agent binary against this machine's Docker, so the whole
  // path is exercised rather than simulated.
  const stateDir = await mkdtemp(join(tmpdir(), 'fleet-e2e-'))
  agent = spawn(
    AGENT_BIN,
    ['--control-plane', API, '--token', pair.body.token, '--log-level', 'info'],
    { env: { ...process.env, FLEET_STATE_DIR: stateDir }, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  agent.stderr?.on('data', (c: Buffer) => {
    for (const line of c.toString().split('\n')) {
      if (line.trim()) console.log(`      [agent] ${line.replace(/\s+/g, ' ').slice(0, 150)}`)
    }
  })
  cleanup.push(async () => {
    agent?.kill('SIGTERM')
    await rm(stateDir, { recursive: true, force: true })
  })

  // Wait for an agent to appear and start heartbeating.
  const deadline = Date.now() + 120_000
  let nodeName = ''
  while (Date.now() < deadline && !nodeName) {
    const nodes = await call('GET', `/fleets/${fleetId}/nodes`, { token })
    const live = nodes.body.nodes?.find((n: any) => n.live)
    if (live) nodeName = live.name
    else await wait(2000)
  }
  if (!nodeName) return bad('no agent registered within 120s')
  ok(`agent joined as "${nodeName}"`)

  section('apply a manifest that builds from source')
  const manifest = `
fleet: homelab
services:
  hello:
    build: apps/hello
    placement: flexible
    resources: { ram: 128Mi }
    health: { path: /healthz }
`
  const applied = await call('POST', `/fleets/${fleetId}/services`, { token, body: { manifest } })
  if (applied.status !== 200) return bad('apply manifest', JSON.stringify(applied.body))
  ok('manifest applied', applied.body.created.join(', '))

  section('deploy — this triggers a real multi-arch build')
  const list = await call('GET', `/fleets/${fleetId}/services`, { token })
  const hello = list.body.services.find((s: any) => s.name === 'hello')
  const started = Date.now()
  const deploy = await call('POST', `/services/${hello.id}/deploy`, { token, body: { gitSha: 'e2e0001' } })
  if (deploy.status !== 201) return bad('deploy', JSON.stringify(deploy.body).slice(0, 400))
  ok(`built and scheduled onto ${deploy.body.placedOn.name}`, `${((Date.now() - started) / 1000).toFixed(1)}s`)

  section('the agent pulls and runs it')
  const runDeadline = Date.now() + 180_000
  let serving = false
  while (Date.now() < runDeadline && !serving) {
    await wait(3000)
    const nodes = await call('GET', `/fleets/${fleetId}/nodes`, { token })
    const node = nodes.body.nodes?.find((n: any) => n.name === deploy.body.placedOn.name)
    const containers = node?.telemetry?.containers ?? []
    const container = containers.find((c: any) => c.name === 'hello')
    if (container) {
      console.log(`      container "hello" state=${container.state}${container.health ? ` health=${container.health}` : ''}`)
      if (container.state === 'running') serving = true
    }
  }
  serving
    ? ok('the agent reported the container running')
    : bad('the container never reached running state within 180s')

  section('the container actually serves traffic')
  const { execSync } = await import('node:child_process')
  try {
    const out = execSync(
      `docker exec fleet-hello wget -qO- http://127.0.0.1:8080/ 2>/dev/null || true`,
      { encoding: 'utf8', timeout: 15_000 }
    ).trim()
    out.includes('fleet-os says hello')
      ? ok('served a response from inside the container', out)
      : bad('the container did not serve the expected body', out.slice(0, 120))
  } catch (err) {
    bad('could not reach the container', String(err).slice(0, 160))
  }

  console.log(`\n${failures === 0 ? '✓ e2e passed' : `✗ ${failures} check(s) failed`}`)
}

main()
  .catch((e) => { console.error('e2e aborted:', e); failures++ })
  .finally(async () => {
    for (const fn of cleanup) await fn().catch(() => {})
    process.exit(failures === 0 ? 0 : 1)
  })
