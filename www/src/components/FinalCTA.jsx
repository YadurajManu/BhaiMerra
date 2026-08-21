import { APP_URL } from '../lib/data'
import Reveal from './ui/Reveal'
import MagneticButton from './ui/MagneticButton'
import CopyLine from './ui/CopyLine'
import StatusDot from './ui/StatusDot'

export default function FinalCTA() {
  return (
    <section id="final" className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 dot-bg opacity-50" />
      <div className="rail relative py-28 lg:py-36">
        <div className="grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <Reveal className="mono-label">get started</Reveal>
            <Reveal i={1}>
              <h2 className="mt-6 text-[clamp(2.1rem,5vw,3.6rem)] font-semibold leading-[0.98] tracking-[-0.045em] text-balance">
                The Pi is already on.
                <span className="block text-[var(--color-fg-dim)]">Give it something to do.</span>
              </h2>
            </Reveal>
            <Reveal i={2}>
              <p className="mt-6 max-w-[46ch] text-[15px] leading-[1.7] text-[var(--color-fg-muted)] text-pretty">
                Install the agent on one machine, push a repo, get a URL. Add the laptop
                and the VPS when you want the thing to survive one of them disappearing.
              </p>
            </Reveal>

            <Reveal i={3} className="mt-9 max-w-[520px]">
              <CopyLine command="curl -fsSL fleet-os.dev/install | sh" />
            </Reveal>

            <Reveal i={4} className="mt-6 flex flex-wrap items-center gap-3">
              <MagneticButton href={APP_URL} variant="primary">
                Start free with one node
              </MagneticButton>
              <MagneticButton href="#cli" variant="ghost" strength={0.16}>
                Documentation
              </MagneticButton>
              <a
                href="#cli"
                className="link-draw ml-1 font-mono text-[11.5px] text-[var(--color-fg-dim)] transition-colors duration-300 hover:text-[var(--color-fg-muted)]"
              >
                github ↗
              </a>
            </Reveal>
          </div>

          {/* a real readout, not decoration: what one node buys you */}
          <Reveal i={2} amount={0.2} className="lg:col-span-4 lg:col-start-9">
            <div className="border border-[var(--color-line)] bg-[var(--color-ink-900)]">
              <div className="flex items-center justify-between border-b border-[var(--color-line)] px-5 py-3">
                <span className="mono-label">first node · checklist</span>
                <StatusDot size={5} />
              </div>
              <ul className="divide-y divide-[var(--color-line)]">
                {[
                  ['install agent', '~15s'],
                  ['capability detected', 'automatic'],
                  ['fleet.yaml written', 'fleet init'],
                  ['first deploy', 'git push'],
                  ['TLS + public URL', 'automatic'],
                  ['port forwarding', 'never'],
                ].map(([k, v]) => (
                  <li key={k} className="flex items-center justify-between px-5 py-3 font-mono text-[11.5px]">
                    <span className="text-[var(--color-fg-muted)]">{k}</span>
                    <span className="text-[var(--color-signal)]">{v}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  )
}
