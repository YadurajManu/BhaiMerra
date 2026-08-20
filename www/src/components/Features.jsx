import { FEATURES } from '../lib/data'
import Reveal from './ui/Reveal'
import TiltCard from './ui/TiltCard'
import SectionHead from './ui/SectionHead'

const SPAN = {
  lg: 'lg:col-span-4',
  md: 'lg:col-span-3',
  sm: 'lg:col-span-2',
}

export default function Features() {
  return (
    <section id="features" className="relative border-b border-[var(--color-line)]">
      <div className="rail py-24 lg:py-32">
        <div className="grid gap-10 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <SectionHead
              index="02"
              kicker="what you get"
              title="The parts a homelab always ends up rebuilding badly."
              max="max-w-[24ch]"
            />
          </div>
          <Reveal i={2} className="self-end lg:col-span-4 lg:col-start-9">
            <p className="text-[14.5px] leading-[1.7] text-[var(--color-fg-muted)] text-pretty">
              None of this is new to anyone who has run servers. The point is that it
              already works together, across devices that do not match, without you
              maintaining the glue.
            </p>
          </Reveal>
        </div>

        <div className="mt-14 grid gap-px bg-[var(--color-line)] lg:grid-cols-6">
          {FEATURES.map((f, i) => (
            <Reveal
              key={f.tag}
              i={i % 3}
              amount={0.2}
              className={`${SPAN[f.span]} bg-[var(--color-ink-950)]`}
            >
              <TiltCard className="group h-full">
                <div className="relative flex h-full flex-col p-7 transition-colors duration-500 hover:bg-[var(--color-ink-900)] lg:p-8">
                  {/* corner tick — the card knows which one it is */}
                  <span className="pointer-events-none absolute right-0 top-0 h-6 w-6 border-r border-t border-[var(--color-line)] opacity-0 transition-opacity duration-500 group-hover:border-[var(--color-signal)] group-hover:opacity-100" />

                  <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--color-fg-dim)] transition-colors duration-500 group-hover:text-[var(--color-signal)]">
                    {f.tag}
                  </span>
                  <h3 className="mt-5 text-[19px] font-semibold leading-[1.2] tracking-[-0.025em]">
                    {f.title}
                  </h3>
                  <p className="mt-3.5 text-[13.5px] leading-[1.65] text-[var(--color-fg-muted)] text-pretty">
                    {f.body}
                  </p>
                  <ul className="mt-6 space-y-2 border-t border-dashed border-[var(--color-line)] pt-5">
                    {f.points.map((p) => (
                      <li key={p} className="flex items-start gap-2.5 font-mono text-[11px] text-[var(--color-fg-dim)]">
                        <span className="mt-[6px] h-1 w-1 shrink-0 bg-[var(--color-signal-dim)]" />
                        {p}
                      </li>
                    ))}
                  </ul>
                </div>
              </TiltCard>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
