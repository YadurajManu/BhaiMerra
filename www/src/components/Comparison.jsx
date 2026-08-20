import { COMPARISON } from '../lib/data'
import Reveal from './ui/Reveal'
import SectionHead from './ui/SectionHead'

const MARK = {
  yes: { glyph: '✓', color: 'var(--color-signal)' },
  no: { glyph: '✕', color: 'var(--color-down)' },
  partial: { glyph: '~', color: 'var(--color-warn)' },
  'n/a': { glyph: '—', color: 'var(--color-fg-dim)' },
  low: { glyph: 'low', color: 'var(--color-signal)' },
  medium: { glyph: 'medium', color: 'var(--color-warn)' },
  high: { glyph: 'high', color: 'var(--color-down)' },
}

function Cell({ value, note, self }) {
  const m = MARK[value] ?? MARK['n/a']
  return (
    <td
      className={`border-t border-[var(--color-line)] px-4 py-4 align-top ${
        self ? 'bg-[color-mix(in_oklab,var(--color-signal)_4%,transparent)]' : ''
      }`}
    >
      <div className="font-mono text-[12px] leading-none" style={{ color: m.color }}>
        {m.glyph}
      </div>
      {note && (
        <div className="mt-2 max-w-[24ch] text-[11.5px] leading-[1.45] text-[var(--color-fg-dim)]">
          {note}
        </div>
      )}
    </td>
  )
}

export default function Comparison() {
  const { columns, rows } = COMPARISON

  return (
    <section id="compare" className="relative border-b border-[var(--color-line)]">
      <div className="rail py-24 lg:py-32">
        <SectionHead
          index="04"
          kicker="where it sits"
          title="Everything here is good at something. This is the something."
          lede="Fleet OS is not trying to be a better Kubernetes or a cheaper Vercel. It occupies the gap between them: a handful of machines you own, that do not match, and are not all reliably on."
          max="max-w-[52ch]"
        />

        {/* the table is 900px wide by necessity; say so rather than letting it
            silently clip on a phone */}
        <Reveal i={0} amount={0.1} className="mt-14 lg:hidden">
          <div className="flex items-center gap-2.5 font-mono text-[10.5px] uppercase tracking-[0.12em] text-[var(--color-fg-dim)]">
            <svg width="14" height="10" viewBox="0 0 14 10" fill="none" aria-hidden="true">
              <path d="M1 5h12M9.5 1.5 13 5l-3.5 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            scroll the table sideways
          </div>
        </Reveal>

        <Reveal
          i={0}
          amount={0.1}
          // fade-scroll-x puts a fade on the right edge below lg, where the
          // table actually overflows — on desktop it fits and the fade would lie
          className="fade-scroll-x relative mt-4 -mx-6 overflow-x-auto px-6 lg:mt-14 lg:mx-0 lg:px-0"
        >
          <table className="w-full min-w-[900px] border-collapse text-left">
            <thead>
              <tr>
                <th className="w-[220px] px-4 py-4 align-bottom">
                  <span className="mono-label">criterion</span>
                </th>
                {columns.map((c) => (
                  <th
                    key={c.key}
                    className={`px-4 py-4 align-bottom ${
                      c.self
                        ? 'bg-[color-mix(in_oklab,var(--color-signal)_6%,transparent)] border-t-2 border-t-[var(--color-signal)]'
                        : ''
                    }`}
                  >
                    <div
                      className={`text-[13.5px] font-semibold leading-tight tracking-[-0.02em] ${
                        c.self ? 'text-[var(--color-signal)]' : 'text-[var(--color-fg)]'
                      }`}
                    >
                      {c.name}
                    </div>
                    <div className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-fg-dim)]">
                      {c.sub}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} className="group">
                  <th
                    scope="row"
                    className="border-t border-[var(--color-line)] px-4 py-4 align-top text-[13px] font-medium leading-snug text-[var(--color-fg-muted)] transition-colors duration-300 group-hover:text-[var(--color-fg)]"
                  >
                    {r.label}
                  </th>
                  {columns.map((c) => (
                    <Cell key={c.key} value={r[c.key][0]} note={r[c.key][1]} self={c.self} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Reveal>

        <Reveal i={1} className="mt-8 max-w-[64ch] border-l border-[var(--color-line-2)] pl-4 text-[13px] leading-[1.7] text-[var(--color-fg-dim)]">
          If your fleet is 200 identical devices, use Balena. If it is 40 nodes in a rack
          with an SRE on call, use K3s. If it is a Pi, a laptop and a $5 VPS, the
          overhead of both is the reason nothing is deployed on them yet.
        </Reveal>
      </div>
    </section>
  )
}
