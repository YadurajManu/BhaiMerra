import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type Fleet, type Node, type Service } from '../lib/api'
import { Button, Copyable, ErrorNote } from '../components/ui'

/**
 * Signup to a running container, without leaving the page.
 *
 * The path existed but nobody was shown it. A new account landed on "No nodes
 * in this fleet yet" beside one button, and everything after that button was
 * undocumented: go to Nodes, mint a token, find the installer, run it, go to
 * Services, understand a manifest format, apply it, then deploy. Each of those
 * is a place to give up, and the gap between signing up and seeing something
 * of your own running is what decides whether anyone comes back.
 *
 * So the two steps that matter happen here. Pairing mints its own token and
 * shows the command; deploying applies a known-good manifest and starts it.
 * Both steps watch for their own completion rather than asking the reader to
 * confirm what the system can already see.
 */

const DISMISSED = 'fleet-os.first-run-dismissed'

type Step = { done: boolean; title: string; body: React.ReactNode }

function StepRow({ n, step, active }: { n: number; step: Step; active: boolean }) {
  return (
    <div className="flex gap-4 px-5 py-4">
      <div
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] transition-colors duration-500 ${
          step.done
            ? 'border-[var(--color-signal)] bg-[var(--color-signal)] text-[#04140c]'
            : active
              ? 'border-[var(--color-signal)] text-[var(--color-signal)]'
              : 'border-[var(--color-line-2)] text-[var(--color-fg-dim)]'
        }`}
      >
        {step.done ? '✓' : n}
      </div>
      <div className="min-w-0 flex-1">
        <div
          className={`font-mono text-[12.5px] ${
            step.done ? 'text-[var(--color-fg-dim)] line-through decoration-1' : 'text-[var(--color-fg)]'
          }`}
        >
          {step.title}
        </div>
        {/* Only the step you are on explains itself. All three expanded at once
            is a wall of instructions rather than a next action. */}
        {active && !step.done && <div className="mt-3">{step.body}</div>}
      </div>
    </div>
  )
}

export default function FirstRun({
  fleet,
  nodes,
  services,
  onChanged,
}: {
  fleet: Fleet
  nodes: Node[]
  services: Service[]
  onChanged: () => void
}) {
  const [hidden, setHidden] = useState(() => localStorage.getItem(DISMISSED) === '1')
  const [pairing, setPairing] = useState<{ install_command: string; expires_at: string } | null>(null)
  const [busy, setBusy] = useState<'pair' | 'deploy' | null>(null)
  const [error, setError] = useState<unknown>(null)

  const hasNode = nodes.length > 0
  const hasService = services.length > 0
  // A Service has no status of its own - it is a declaration. Whether anything
  // is actually up lives on its current deployment, and `current` is null in
  // exactly the case where nothing is running.
  const running = services.some((s) => s.current?.status === 'running')
  const complete = hasNode && hasService && running

  // The token is minted as soon as the reader arrives on step one, because
  // pairing is the step and making them press a button to reveal the command
  // is a click that teaches nothing.
  const mint = useCallback(async () => {
    setBusy('pair')
    setError(null)
    try {
      setPairing(await api(`/fleets/${fleet.id}/nodes/pair-token`, { method: 'POST' }))
    } catch (err) {
      setError(err)
    } finally {
      setBusy(null)
    }
  }, [fleet.id])

  useEffect(() => {
    if (!hasNode && !pairing && !hidden) void mint()
  }, [hasNode, pairing, hidden, mint])

  const deployDemo = async () => {
    setBusy('deploy')
    setError(null)
    // The fleet's real name, not a placeholder. The reader may well copy this
    // manifest into a repo, and a file naming somebody else's fleet is a
    // puzzle to debug later.
    const manifest = `fleet: ${fleet.name}

services:
  hello:
    image: nginx:1.27-alpine
    placement: flexible
    port: 80
    container_port: 80
    resources: { ram: 128Mi, cpu: 0.2 }
    health: { path: / }
`
    try {
      const applied = await api<{ services?: Array<{ id: string; name: string }> }>(
        `/fleets/${fleet.id}/services`,
        { method: 'POST', body: { manifest } }
      )
      // Applying only writes the definition. Without this the reader is left
      // with a service that exists and does nothing, which reads as a failure.
      const first = applied.services?.[0]
      if (first) await api(`/services/${first.id}/deploy`, { method: 'POST', body: {} })
      onChanged()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(null)
    }
  }

  if (hidden || complete) return null

  const steps: Step[] = [
    {
      done: hasNode,
      title: 'Pair a machine',
      body: (
        <div className="space-y-3">
          <p className="text-[13px] leading-relaxed text-[var(--color-fg-muted)]">
            Run this on any machine you own — a Pi, an old laptop, a spare mini PC. It needs
            Docker and an outbound internet connection; nothing has to be reachable from outside.
          </p>
          {pairing ? (
            <>
              <Copyable text={pairing.install_command} className="text-[11px]" />
              <p className="flex items-center gap-2 font-mono text-[11px] text-[var(--color-fg-dim)]">
                <span className="breathe inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-signal)]" />
                waiting for the agent to report — this page notices on its own
              </p>
            </>
          ) : (
            <Button onClick={() => void mint()} disabled={busy === 'pair'}>
              {busy === 'pair' ? 'Minting…' : 'Get the install command'}
            </Button>
          )}
        </div>
      ),
    },
    {
      done: hasService,
      title: 'Deploy something',
      body: (
        <div className="space-y-3">
          <p className="text-[13px] leading-relaxed text-[var(--color-fg-muted)]">
            This starts a small nginx container on the machine you just paired, so you can see a
            deploy work end to end before writing anything of your own.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={() => void deployDemo()} disabled={busy === 'deploy'}>
              {busy === 'deploy' ? 'Deploying…' : 'Deploy a test service'}
            </Button>
            <Link
              to="/services"
              className="font-mono text-[11.5px] text-[var(--color-fg-dim)] underline-offset-4 hover:text-[var(--color-fg)] hover:underline"
            >
              or write your own manifest
            </Link>
          </div>
        </div>
      ),
    },
    {
      done: running,
      title: 'Watch it come up',
      body: (
        <p className="text-[13px] leading-relaxed text-[var(--color-fg-muted)]">
          The image is being pulled and placed on a node. It appears on{' '}
          <Link to="/services" className="text-[var(--color-signal)] underline-offset-4 hover:underline">
            Services
          </Link>{' '}
          as soon as the container is running.
        </p>
      ),
    },
  ]

  const activeIndex = steps.findIndex((s) => !s.done)

  return (
    <div className="panel fade-up overflow-hidden">
      <div className="flex items-center gap-3 border-b border-[var(--color-line)] px-5 py-3">
        <h2 className="mono-label text-[11px] text-[var(--color-fg)]">first run</h2>
        <span className="font-mono text-[10.5px] text-[var(--color-fg-dim)]">
          {steps.filter((s) => s.done).length} of {steps.length} done
        </span>
        <button
          onClick={() => {
            localStorage.setItem(DISMISSED, '1')
            setHidden(true)
          }}
          className="ml-auto font-mono text-[10.5px] text-[var(--color-fg-dim)] underline-offset-4 hover:text-[var(--color-fg)] hover:underline"
        >
          hide
        </button>
      </div>

      {error != null && (
        <div className="px-5 pt-4">
          <ErrorNote error={error} />
        </div>
      )}

      <div className="divide-y divide-[var(--color-line)]">
        {steps.map((s, i) => (
          <StepRow key={s.title} n={i + 1} step={s} active={i === activeIndex} />
        ))}
      </div>
    </div>
  )
}
