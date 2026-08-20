import Reveal from './ui/Reveal'

const OPTIONS = [
  {
    tag: 'option a',
    title: 'Rent everything',
    lines: [
      'Deploy experience is genuinely good',
      'You pay monthly for compute that idles',
      'The Pi in the drawer stays in the drawer',
      'Scaling down still costs the floor price',
    ],
    verdict: '$21/mo to serve 400 requests a day',
  },
  {
    tag: 'option b',
    title: 'Wire it up yourself',
    lines: [
      'Hardware is already paid for and sitting there',
      'docker compose up, then a reverse proxy, then certs',
      'Then port forwarding, then a dynamic DNS script',
      'Then the laptop sleeps and nobody finds out until morning',
    ],
    verdict: 'Free, until the weekend it is not',
  },
]

export default function Problem() {
  return (
    <section className="relative border-b border-[var(--color-line)]">
      <div className="rail py-24 lg:py-32">
        <Reveal className="mono-label" y={8} duration={0.5}>
          the two options, currently
        </Reveal>

        <div className="mt-10 grid gap-px border border-[var(--color-line)] bg-[var(--color-line)] lg:grid-cols-2">
          {OPTIONS.map((o, i) => (
            <Reveal
              key={o.tag}
              i={i}
              className="relative bg-[var(--color-ink-950)] p-7 lg:p-10"
            >
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-fg-dim)]">
                  {o.tag}
                </span>
                <span className="font-mono text-[10.5px] text-[var(--color-down)]">rejected</span>
              </div>

              <h3 className="mt-5 text-[clamp(1.5rem,2.6vw,2.1rem)] font-semibold tracking-[-0.035em]">
                {o.title}
              </h3>

              <ul className="mt-7 space-y-3.5">
                {o.lines.map((l) => (
                  <li key={l} className="flex gap-3.5 text-[14px] leading-snug text-[var(--color-fg-muted)]">
                    <span className="mt-[7px] h-px w-4 shrink-0 bg-[var(--color-line-2)]" />
                    {l}
                  </li>
                ))}
              </ul>

              <div className="mt-8 border-t border-dashed border-[var(--color-line)] pt-4 font-mono text-[12px] text-[var(--color-fg-dim)]">
                {o.verdict}
              </div>
            </Reveal>
          ))}
        </div>

        {/* the resolution, deliberately a third row rather than a third card */}
        <Reveal i={2} className="border-x border-b border-[var(--color-line)] bg-[var(--color-ink-900)]">
          <div className="grid items-center gap-6 p-7 lg:grid-cols-[auto_1fr_auto] lg:gap-10 lg:p-10">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-signal)]">
              option c
            </span>
            <p className="text-[clamp(1.05rem,1.9vw,1.4rem)] leading-[1.4] tracking-[-0.02em] text-balance">
              Keep the hardware. Add a control plane that treats a machine going
              offline as a scheduling event instead of an outage.
            </p>
            <span className="font-mono text-[11px] text-[var(--color-fg-dim)] lg:text-right">
              fleet·os
            </span>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
