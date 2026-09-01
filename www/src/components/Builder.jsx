import Reveal from './ui/Reveal'
import SectionHead from './ui/SectionHead'

/**
 * Who built this.
 *
 * Infrastructure asks for more trust than most software: it wants your
 * machines, your credentials and your customers' data. A project with no name
 * behind it is asking for that on the strength of a README. This section is
 * the answer to "who is this person, and have they built anything that had to
 * survive contact with real use".
 */

const WORK = [
  {
    name: 'Aarogya Setu',
    what: 'Multi-tenant hospital SaaS — OPD and IPD queues, EMR, billing.',
    note: 'multi-tenant',
  },
  {
    name: 'Tollgate',
    what: 'Cost observability for LLM APIs. In progress.',
    note: 'current',
  },
  {
    name: 'MuhDikhai',
    what: 'Anonymous video chat, with WebRTC signalling written by hand.',
    note: 'realtime',
  },
  {
    name: 'SecondMind / CortX',
    what: 'A cognitive OS on an ESP32-S3: voice in, local LLM, speech out.',
    note: 'firmware',
  },
  {
    name: 'CineVerse',
    what: 'Social film tracking across 500k+ titles from TMDB.',
    note: 'product',
  },
  {
    name: 'Maakosh',
    what: 'Maternal health monitoring with wearable sensor integration.',
    note: 'sensors',
  },
]

const LINKS = [
  ['yaduraj.me', 'https://yaduraj.me'],
  ['GitHub', 'https://github.com/YadurajManu'],
  ['LinkedIn', 'https://www.linkedin.com/in/yadurajenc'],
]

// This section is the summary. The page is where the argument gets made —
// including the half about what a one-person project cannot give you.
const FULL_PAGE = '#/founder'

export default function Builder() {
  return (
    <section id="builder" className="relative border-b border-[var(--color-line)]">
      <div className="rail py-24 lg:py-32">
        <SectionHead
          index="07"
          kicker="who built this"
          title="One person, who kept running out of somewhere to deploy."
          lede="Fleet OS came out of having a drawer of working computers and no way to treat them as one target. Everything here was built to run something real first, and generalised afterwards."
          max="max-w-[52ch]"
        />

        <div className="mt-16 grid gap-px bg-[var(--color-line)] lg:grid-cols-[1fr_1.35fr]">
          {/* Identity */}
          <Reveal className="bg-[var(--color-ink-950)] p-8 lg:p-10">
            <div className="flex items-baseline gap-3">
              <h3 className="text-[22px] font-semibold tracking-[-0.03em]">Yaduraj Singh</h3>
              <span className="font-mono text-[11px] text-[var(--color-fg-dim)]">20</span>
            </div>
            <p className="mt-2 font-mono text-[12px] text-[var(--color-signal)]">
              full-stack engineer · AI/ML
            </p>
            <p className="mt-1 font-mono text-[11.5px] text-[var(--color-fg-dim)]">
              Dehradun · Greater Noida, India
            </p>

            <p className="mt-6 max-w-[46ch] text-[14.5px] leading-[1.7] text-[var(--color-fg-muted)] text-pretty">
              Builds production systems across an unusually wide range — firmware on an ESP32
              through to multi-tenant SaaS and iOS apps. Fleet OS is the piece of that work that
              turned out to be useful to everybody else.
            </p>

            <div className="mt-8 flex flex-wrap gap-x-5 gap-y-2">
              {LINKS.map(([label, href]) => (
                <a
                  key={label}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group font-mono text-[12px] text-[var(--color-fg-muted)] transition-colors duration-300 hover:text-[var(--color-fg)]"
                >
                  {label}
                  <span className="ml-1 text-[var(--color-fg-dim)] transition-colors duration-300 group-hover:text-[var(--color-signal)]">
                    ↗
                  </span>
                </a>
              ))}
            </div>

            {/* The stack, as a fact rather than a badge wall. */}
            <div className="mt-10 border-t border-[var(--color-line)] pt-6">
              <div className="mono-label">also built with</div>
              <p className="mt-3 font-mono text-[11.5px] leading-[1.9] text-[var(--color-fg-dim)]">
                TypeScript · Go · Swift · C/C++ · React · Next.js · Node · WebRTC ·
                Postgres · Redis · Docker · ESP32-S3
              </p>
            </div>
          </Reveal>

          {/* Prior work, because "trust me" is not an argument. */}
          <div className="grid gap-px bg-[var(--color-line)] sm:grid-cols-2">
            {WORK.map((w, i) => (
              <Reveal
                key={w.name}
                i={i}
                className="group bg-[var(--color-ink-950)] p-6 transition-colors duration-400 hover:bg-[var(--color-ink-900)]"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[14px] font-medium tracking-[-0.015em] text-[var(--color-fg)]">
                    {w.name}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-[var(--color-fg-dim)] transition-colors duration-300 group-hover:text-[var(--color-signal)]">
                    {w.note}
                  </span>
                </div>
                <p className="mt-2.5 text-[12.5px] leading-[1.6] text-[var(--color-fg-muted)] text-pretty">
                  {w.what}
                </p>
              </Reveal>
            ))}
          </div>
        </div>

        <Reveal i={2} className="mt-10 flex flex-wrap items-end justify-between gap-6">
          <p className="max-w-[62ch] text-[13.5px] leading-[1.7] text-[var(--color-fg-dim)] text-pretty">
            Fleet OS is MIT-licensed and developed in the open. Read the source, file an issue,
            or take the whole thing and run it yourself — the control plane is a Docker Compose
            file, and it never phones home.
          </p>
          <a
            href={FULL_PAGE}
            className="group shrink-0 font-mono text-[12.5px] text-[var(--color-signal)]"
          >
            <span className="link-draw">the longer version</span>
            <span className="ml-1.5 inline-block transition-transform duration-300 group-hover:translate-x-1">
              →
            </span>
          </a>
        </Reveal>
      </div>
    </section>
  )
}
