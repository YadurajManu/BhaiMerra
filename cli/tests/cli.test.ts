import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, KNOWN_FLAGS, nearestFlag } from '../src/args.js'
import { etaLine, progressLine } from '../src/progress.js'
import { alertCheck, healthPathCheck } from '../src/commands/doctor.js'
import { tuneRam, asQuantity, type Observed } from '../src/tune.js'
import { table, relativeTime, mb, visibleLength, truncate, c } from '../src/render.js'
import { readFileSync, readdirSync } from 'node:fs'

describe('argument parsing', () => {
  test('separates positionals from flags', () => {
    const { positional, flags } = parseArgs(['deploy', 'web', '--sha', '4f1c9ae'])
    assert.deepEqual(positional, ['deploy', 'web'])
    assert.equal(flags.sha, '4f1c9ae')
  })

  test('a flag with no value is boolean', () => {
    const { flags } = parseArgs(['nodes', '--json'])
    assert.equal(flags.json, true)
  })

  test('a trailing flag does not swallow the next command', () => {
    const { positional, flags } = parseArgs(['nodes', 'rm', 'pi5', '--force'])
    assert.deepEqual(positional, ['nodes', 'rm', 'pi5'])
    assert.equal(flags.force, true)
  })

  test('short and long forms both work', () => {
    assert.equal(parseArgs(['-h']).flags.h, true)
    assert.equal(parseArgs(['--help']).flags.help, true)
  })

  test('a flag value that looks like a path is kept', () => {
    assert.equal(parseArgs(['apply', '--fleet', 'abc-123']).flags.fleet, 'abc-123')
  })
})

describe('rendering', () => {
  test('columns align on visible width, ignoring colour codes', () => {
    // Counting escape bytes toward the width makes every column drift.
    const coloured = c.green('online')
    assert.equal(visibleLength(coloured), 'online'.length)

    const out = table(['a', 'b'], [[coloured, 'x'], ['offline', 'y']])
    const [, first, second] = out.split('\n')
    // Both rows should place column b at the same visible offset.
    assert.equal(
      visibleLength(first!.slice(0, first!.lastIndexOf('x'))),
      visibleLength(second!.slice(0, second!.lastIndexOf('y')))
    )
  })

  test('an empty table renders nothing rather than a lonely header', () => {
    assert.equal(table(['name', 'status'], []), '')
  })

  test('relative time works in both directions', () => {
    const past = new Date(Date.now() - 90_000).toISOString()
    const future = new Date(Date.now() + 600_000).toISOString()
    assert.match(relativeTime(past), /2m ago/)
    // A pairing token expires ahead of now; "-600s from now" is nonsense.
    assert.match(relativeTime(future), /10m from now/)
    assert.equal(relativeTime(null), 'never')
  })

  test('memory is shown in the unit a human would use', () => {
    assert.equal(mb(512), '512MB')
    assert.equal(mb(16384), '16.0GB')
  })

  test('truncation respects terminal cells and keeps ANSI sequences balanced', () => {
    // Write the sequence explicitly: tests intentionally run without a TTY,
    // where the colour helpers correctly return plain text.
    const coloured = '\x1b[38;2;63;224;139mdeploying 🚀 東京\x1b[0m'
    const cut = truncate(coloured, 10)
    assert.ok(visibleLength(cut) <= 10)
    assert.match(cut, /…/)
    assert.match(cut, /\x1b\[0m$/)

    // Combining marks are one visible character, and plain text must not
    // acquire a control sequence just because it was shortened.
    assert.equal(visibleLength('e\u0301'), 1)
    assert.equal(truncate('abcdefgh', 4), 'abc…')
  })
})

describe('apply --dry-run', () => {
  test('is wired to the validate endpoint, not the apply one', () => {
    // It used to be accepted and ignored, so `fleet apply --dry-run` applied.
    // `fleet init` prints that exact command as the safe way to check its
    // output, which made the one command the tool recommends for looking
    // before you leap the command that leapt. This asserts the source, because
    // the failure mode is a flag silently doing nothing — which no output
    // assertion would have caught either.
    const src = readFileSync(new URL('../src/commands/services.ts', import.meta.url), 'utf8')
    const apply = src.slice(src.indexOf('export const applyCommand'))

    const dryRunAt = apply.indexOf("flags['dry-run']")
    const validateAt = apply.indexOf('/services/validate')
    const postAt = apply.indexOf("'POST', `/fleets/${fleetId}/services`")

    assert.ok(dryRunAt > -1, 'apply must read the dry-run flag')
    assert.ok(validateAt > -1, 'and send the manifest to the validate endpoint')
    assert.ok(
      validateAt < postAt,
      'the validate path must return before the applying one is reached'
    )
  })
})

describe('unknown flags', () => {
  test('every flag the CLI reads is in the registry', () => {
    // The registry only helps while it is complete. A flag added to a command
    // and forgotten here would be refused for everyone — worse than the
    // silence it replaced — so this reads the source rather than trusting it.
    const dir = new URL('../src/', import.meta.url)
    const files = readdirSync(dir, { recursive: true }) as string[]
    const used = new Set<string>()

    for (const f of files) {
      if (!String(f).endsWith('.ts')) continue
      const src = readFileSync(new URL(String(f), dir), 'utf8')
      for (const m of src.matchAll(/flags\.([a-zA-Z][a-zA-Z0-9]*)/g)) used.add(m[1]!)
      for (const m of src.matchAll(/flags\['([a-z-]+)'\]/g)) used.add(m[1]!)
    }

    const missing = [...used].filter((f) => !KNOWN_FLAGS.has(f))
    assert.deepEqual(missing, [], `these flags are read but not registered: ${missing.join(', ')}`)
  })

  test('a truncated or extended flag suggests the real one', () => {
    // `fleet init --ai` on a build without --ai was silently ignored, and read
    // as the feature being broken. The same shape of mistake — a flag with
    // something on the end — must point at the real one.
    assert.equal(nearestFlag('ai-typo'), 'ai')
    assert.equal(nearestFlag('node2'), 'node')
  })

  test('a mistyped flag suggests the real one', () => {
    assert.equal(nearestFlag('jsno'), 'json')
    assert.equal(nearestFlag('drt-run'), 'dry-run')
  })

  test('something with no relation suggests nothing', () => {
    // A confident wrong suggestion is worse than none.
    assert.equal(nearestFlag('nonsense'), null)
  })
})

describe('the deploy estimate', () => {
  test('is drawn from real history, and says how much is left', () => {
    const p = {
      deploymentId: 'd1',
      status: 'building',
      since: new Date(Date.now() - 60_000).toISOString(),
      gitSha: null,
      nodeName: null,
      failureReason: null,
      typicalMs: 180_000,
    }
    const line = etaLine(p)!
    assert.match(line, /1m/, 'elapsed')
    assert.match(line, /left/, 'and what remains')
  })

  test('says nothing at all on a first deploy', () => {
    // There is no honest estimate without history, and a bar filled from a
    // number nobody measured is the same lie as "not needed".
    const p = {
      deploymentId: 'd1',
      status: 'building',
      since: new Date().toISOString(),
      gitSha: null,
      nodeName: null,
      failureReason: null,
    }
    assert.equal(etaLine(p), undefined)
  })

  test('an overrun is reported as an overrun, not parked at the end', () => {
    // A deploy that is slower than usual is exactly when somebody needs to
    // know, and a bar stuck at 100% is how progress bars lose their meaning.
    const p = {
      deploymentId: 'd1',
      status: 'building',
      since: new Date(Date.now() - 300_000).toISOString(),
      gitSha: null,
      nodeName: null,
      failureReason: null,
      typicalMs: 120_000,
    }
    assert.match(etaLine(p)!, /over the usual/)
  })

  test('emulation is named on the build line', () => {
    // The answer to "why is this taking so long" for almost every slow build
    // in this system.
    const line = progressLine({
      deploymentId: 'd1',
      status: 'building',
      since: new Date().toISOString(),
      gitSha: null,
      nodeName: null,
      failureReason: null,
      detail: 'RUN npm ci',
      step: 4,
      ofSteps: 9,
      platform: 'linux/arm64',
      emulated: true,
    })!
    assert.match(line, /4\/9/)
    assert.match(line, /arm64/)
    assert.match(line, /emulated/)
  })
})

describe('the alerts check', () => {
  test('a fleet with no rules is warned about, and told what to run', () => {
    // The case that matters, and the one a live check against a working fleet
    // never reaches. This fleet had no rules while its services went down four
    // times in an afternoon.
    const c = alertCheck([])
    assert.equal(c.state, 'warn')
    assert.match(c.detail, /tell nobody/)
    assert.match(c.remedy!, /fleet alerts add/)
  })

  test('rules that exist but are all disabled say so specifically', () => {
    // Set up and switched off is a different mistake from never set up, and
    // the person reading needs to know which one they made.
    const c = alertCheck([{ channelType: 'email', enabled: false }])
    assert.equal(c.state, 'warn')
    assert.match(c.detail, /disabled/)
  })

  test('a working rule passes, naming the channels', () => {
    const c = alertCheck([
      { channelType: 'email', enabled: true },
      { channelType: 'email', enabled: true },
      { channelType: 'slack', enabled: false },
    ])
    assert.equal(c.state, 'ok')
    assert.match(c.detail, /2 rule/)
    assert.match(c.detail, /email/)
    assert.ok(!c.detail.includes('slack'), 'a disabled channel is not protection')
  })
})
describe('the health paths a service actually answers on', () => {
  const svc = (name: string, discoveredHealth: Array<{ path: string; status: number; bytes: number }> | null) => ({
    id: name, name, domain: null, hostname: null, current: null, discoveredHealth,
  })

  test('suggests the path a service answers on but does not declare', () => {
    // `fleet init` writes "Add one once you know a path that returns 2xx" and
    // leaves the reader to find out. The node found out.
    const check = healthPathCheck([
      svc('backend', [
        { path: '/health', status: 404, bytes: 0 },
        { path: '/healthz', status: 200, bytes: 2 },
        { path: '/', status: 404, bytes: 0 },
      ]),
    ])
    assert.equal(check.state, 'warn')
    assert.match(check.detail, /backend → \/healthz/)
    assert.match(check.remedy!, /health: \{ path: \/healthz \}/)
  })

  test('prefers a dedicated endpoint over root when both answer', () => {
    // A check that renders the whole application every ten seconds for the life
    // of the deployment is the worse of two working answers. The node tries
    // them in preference order; this must not re-sort them.
    const check = healthPathCheck([
      svc('web', [
        { path: '/healthz', status: 200, bytes: 2 },
        { path: '/', status: 200, bytes: 41_000 },
      ]),
    ])
    assert.match(check.detail, /web → \/healthz/)
  })

  test('a service where nothing answered is not a warning', () => {
    // Its manifest is already correct — it says container state decides, and
    // that is now a measured fact rather than a default. Telling somebody their
    // correct configuration is a problem is how a health report gets ignored.
    const check = healthPathCheck([
      svc('backend', [
        { path: '/health', status: 404, bytes: 0 },
        { path: '/', status: 404, bytes: 0 },
      ]),
    ])
    assert.equal(check.state, 'ok')
    assert.match(check.detail, /answered nothing/)
  })

  test('says nothing about services that were never swept', () => {
    const check = healthPathCheck([svc('api', null)])
    assert.equal(check.state, 'ok')
    assert.match(check.detail, /declares a health check, or none has been swept/)
  })
})


describe('what a service should reserve, from what it used', () => {
  const HOUR = 3_600_000
  const now = Date.parse('2026-09-05T12:00:00Z')
  const svc = (o: Partial<Observed> = {}): Observed => ({
    name: 'backend',
    requestRamMb: 512,
    observedRamPeakMb: 60,
    observedRamSince: new Date(now - 48 * HOUR).toISOString(),
    ...o,
  })

  test('advises shrinking a reservation the service never approaches', () => {
    // The real numbers from this fleet: 512Mi reserved, ~60MB used.
    const a = tuneRam(svc(), now)
    assert.equal(a.verdict, 'advise')
    if (a.verdict !== 'advise') return
    assert.equal(a.from, 512)
    assert.equal(a.to, 128, 'double the peak, rounded to a number a person would write')
  })

  test('refuses to advise from an observation too short to mean anything', () => {
    // A service watched for four minutes has not been observed, it has been
    // glanced at. Nothing that runs a nightly job has shown its peak yet, and
    // advising from that is how a tuned fleet starts OOM-killing at 3am.
    const a = tuneRam(svc({ observedRamSince: new Date(now - 4 * 60_000).toISOString() }), now)
    assert.equal(a.verdict, 'too-soon')
  })

  test('says nothing at all about a service never measured', () => {
    const a = tuneRam(svc({ observedRamPeakMb: null }), now)
    assert.equal(a.verdict, 'no-data')
  })

  test('never advises shrinking below the peak', () => {
    // The reservation is the container's hard limit. Trimming to the bone is
    // how a tuning tool gets run exactly once.
    for (const peak of [1, 30, 60, 100, 200, 255]) {
      const a = tuneRam(svc({ observedRamPeakMb: peak }), now)
      if (a.verdict !== 'advise') continue
      assert.ok(a.to > peak, `advised ${a.to}MB for a service that peaked at ${peak}MB`)
    }
  })

  test('warns rather than trims when a service is near its limit', () => {
    // Not a saving. A service peaking at four fifths of its reservation is one
    // traffic spike from being killed, and that is the finding.
    const a = tuneRam(svc({ observedRamPeakMb: 450 }), now)
    assert.equal(a.verdict, 'tight')
  })

  test('leaves a reservation that is already about right alone', () => {
    const a = tuneRam(svc({ requestRamMb: 128, observedRamPeakMb: 60 }), now)
    assert.equal(a.verdict, 'fits')
  })

  test('writes megabytes the way a manifest does', () => {
    assert.equal(asQuantity(128), '128Mi')
    assert.equal(asQuantity(1024), '1Gi')
  })
})
