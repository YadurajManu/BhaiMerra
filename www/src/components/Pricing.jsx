import { PLANS } from '../lib/data'
import Reveal from './ui/Reveal'
import SectionHead from './ui/SectionHead'
import MagneticButton from './ui/MagneticButton'

export default function Pricing() {
  return (
    <section id="pricing" className="relative border-b border-[var(--color-line)]">
      <div className="rail py-24 lg:py-32">
        <SectionHead
          index="06"
          kicker="pricing"
          title="One node is free. The fleet is the paid part."
          lede="The free tier is not a demo — it is the full deploy experience on a single machine. You start paying when you have more than one node and want them to cover for each other."
          max="max-w-[50ch]"
        />

        <div className="mt-14 grid gap-px bg-[var(--color-line)] lg:grid-cols-3">
          {PLANS.map((p, i) => (
            <Reveal
              key={p.name}
              i={i}
              amount={0.2}
              className={`relative flex flex-col p-7 lg:p-9 ${
                p.highlight ? 'bg-[var(--color-ink-850)]' : 'bg-[var(--color-ink-950)]'
              }`}
            >
              {p.highlight && (
                <span className="absolute left-0 right-0 top-0 h-px bg-[var(--color-signal)]" />
              )}

              <div className="flex items-baseline justify-between">
                <h3 className="font-mono text-[12px] uppercase tracking-[0.16em] text-[var(--color-fg)]">
                  {p.name}
                </h3>
                {p.highlight && (
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-signal)]">
                    most fleets
                  </span>
                )}
              </div>

              <div className="mt-7 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-[clamp(2rem,3.4vw,2.7rem)] font-semibold leading-none tracking-[-0.04em]">
                  {p.price}
                </span>
                <span className="font-mono text-[11.5px] text-[var(--color-fg-dim)]">{p.unit}</span>
              </div>

              <p className="mt-4 text-[13.5px] leading-relaxed text-[var(--color-fg-muted)]">
                {p.line}
              </p>

              <ul className="mt-8 flex-1 space-y-3 border-t border-dashed border-[var(--color-line)] pt-7">
                {p.features.map((f) => (
                  <li key={f} className="flex items-start gap-3 text-[13px] leading-snug text-[var(--color-fg-muted)]">
                    <span className="mt-[6px] h-1 w-1 shrink-0 bg-[var(--color-signal)]" />
                    {f}
                  </li>
                ))}
              </ul>

              <div className="mt-9">
                <MagneticButton
                  href="#final"
                  variant={p.highlight ? 'primary' : 'ghost'}
                  strength={0.16}
                  className="w-full justify-center"
                >
                  {p.cta}
                </MagneticButton>
                <p className="mt-4 font-mono text-[10.5px] leading-relaxed text-[var(--color-fg-dim)]">
                  {p.note}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
