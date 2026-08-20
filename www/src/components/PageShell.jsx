import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { PAGES, PAGE_ORDER } from '../lib/pages'
import { EASE } from '../lib/motion'
import Reveal from './ui/Reveal'
import StatusDot from './ui/StatusDot'

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/* ── block renderers ─────────────────────────────────────────────── */

function CodeBlock({ lang, lines }) {
  return (
    <div className="my-7 border border-[var(--color-line)] bg-[#07080a]">
      <div className="flex items-center justify-between border-b border-[var(--color-line)] px-4 py-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-dim)]">
          {lang}
        </span>
        <StatusDot tone="idle" size={5} />
      </div>
      <pre className="no-scrollbar overflow-x-auto px-4 py-3.5 font-mono text-[12px] leading-[1.75]">
        {lines.map((l, i) => (
          <div
            key={i}
            style={{
              color: l.startsWith('$') || l.startsWith('#')
                ? 'var(--color-fg)'
                : l.trimStart().startsWith('✓') || l.trimStart().startsWith('→')
                  ? 'var(--color-signal)'
                  : 'var(--color-fg-muted)',
            }}
          >
            {l || ' '}
          </div>
        ))}
      </pre>
    </div>
  )
}

function KV({ rows }) {
  return (
    <dl className="my-7 border-t border-[var(--color-line)]">
      {rows.map(([k, v]) => (
        <div
          key={k}
          className="grid gap-1 border-b border-[var(--color-line)] py-3.5 sm:grid-cols-[minmax(0,220px)_1fr] sm:gap-6"
        >
          <dt className="font-mono text-[12px] text-[var(--color-fg)]">{k}</dt>
          <dd className="text-[13.5px] leading-relaxed text-[var(--color-fg-muted)]">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function Table({ head, rows }) {
  return (
    <div className="my-7 -mx-6 overflow-x-auto px-6 sm:mx-0 sm:px-0">
      <table className="w-full min-w-[560px] border-collapse text-left">
        <thead>
          <tr>
            {head.map((h) => (
              <th
                key={h}
                className="border-b border-[var(--color-line-2)] px-3 py-2.5 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-fg-dim)] first:pl-0"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="group">
              {r.map((c, j) => (
                <td
                  key={j}
                  className={`border-b border-[var(--color-line)] px-3 py-2.5 align-top text-[12.5px] leading-snug first:pl-0 ${
                    j === 0
                      ? 'font-mono text-[12px] text-[var(--color-fg)]'
                      : 'text-[var(--color-fg-muted)]'
                  }`}
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Note({ tone, text }) {
  const c = tone === 'warn' ? 'var(--color-warn)' : 'var(--color-signal)'
  return (
    <div
      className="my-7 border-l-2 py-3 pl-4"
      style={{ borderColor: c, background: `color-mix(in oklab, ${c} 5%, transparent)` }}
    >
      <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em]" style={{ color: c }}>
        {tone === 'warn' ? 'careful' : 'note'}
      </div>
      <p className="text-[13.5px] leading-relaxed text-[var(--color-fg-muted)]">{text}</p>
    </div>
  )
}

function LinkCards({ items }) {
  return (
    <div className="my-7 grid gap-px bg-[var(--color-line)] sm:grid-cols-2">
      {items.map(([label, href, desc]) => {
        const external = href.startsWith('http')
        return (
          <motion.a
            key={label}
            href={href}
            {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            whileHover={{ y: -2 }}
            transition={{ type: 'spring', stiffness: 300, damping: 24 }}
            className="group block bg-[var(--color-ink-950)] p-5 transition-colors duration-400 hover:bg-[var(--color-ink-900)]"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-[14px] font-medium tracking-[-0.015em] text-[var(--color-fg)]">
                {label}
              </span>
              <span className="font-mono text-[11px] text-[var(--color-fg-dim)] transition-colors duration-300 group-hover:text-[var(--color-signal)]">
                {external ? '↗' : '→'}
              </span>
            </div>
            <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--color-fg-muted)]">{desc}</p>
          </motion.a>
        )
      })}
    </div>
  )
}

function StatusRows({ rows }) {
  return (
    <div className="my-7 border border-[var(--color-line)]">
      {rows.map(([name, state, uptime], i) => (
        <motion.div
          key={name}
          initial={{ opacity: 0, x: -6 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: i * 0.06, ease: EASE.expo }}
          className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-line)] px-4 py-3 last:border-b-0"
        >
          <span className="flex items-center gap-2.5 text-[13px] text-[var(--color-fg)]">
            <StatusDot size={6} />
            {name}
          </span>
          <span className="flex items-center gap-5 font-mono text-[10.5px]">
            <span className="text-[var(--color-signal)]">{state}</span>
            <span className="text-[var(--color-fg-dim)]">{uptime}</span>
          </span>
        </motion.div>
      ))}
    </div>
  )
}

function Block({ b }) {
  switch (b.t) {
    case 'h':
      return (
        <h2
          id={slug(b.text)}
          className="mt-14 scroll-mt-24 border-t border-[var(--color-line)] pt-7 text-[20px] font-semibold tracking-[-0.025em] first:mt-0 first:border-0 first:pt-0"
        >
          {b.text}
        </h2>
      )
    case 'p':
      return (
        <p className="my-5 text-[14.5px] leading-[1.75] text-[var(--color-fg-muted)] text-pretty">
          {b.text}
        </p>
      )
    case 'list':
      return (
        <ul className="my-6 space-y-3">
          {b.items.map((it) => (
            <li key={it} className="flex gap-3.5 text-[14px] leading-[1.65] text-[var(--color-fg-muted)]">
              <span className="mt-[9px] h-1 w-1 shrink-0 bg-[var(--color-signal)]" />
              <span>{it}</span>
            </li>
          ))}
        </ul>
      )
    case 'code':
      return <CodeBlock {...b} />
    case 'kv':
      return <KV rows={b.rows} />
    case 'table':
      return <Table head={b.head} rows={b.rows} />
    case 'note':
      return <Note tone={b.tone} text={b.text} />
    case 'links':
      return <LinkCards items={b.items} />
    case 'status':
      return <StatusRows rows={b.rows} />
    default:
      return null
  }
}

/* ── the page ────────────────────────────────────────────────────── */

export default function PageShell({ route }) {
  const page = PAGES[route]
  const mainRef = useRef(null)
  const [activeId, setActiveId] = useState(null)

  const toc = useMemo(
    () => (page ? page.blocks.filter((b) => b.t === 'h').map((b) => b.text) : []),
    [page]
  )

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [route])

  // highlight the section the reader is currently in
  useEffect(() => {
    if (!page) return
    const heads = Array.from(mainRef.current?.querySelectorAll('h2[id]') ?? [])
    if (!heads.length) return
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting)
        if (visible.length) setActiveId(visible[0].target.id)
      },
      { rootMargin: '-80px 0px -70% 0px' }
    )
    heads.forEach((h) => io.observe(h))
    return () => io.disconnect()
  }, [page, route])

  if (!page) {
    return (
      <div className="rail flex min-h-[70vh] flex-col justify-center py-32">
        <span className="mono-label">404</span>
        <h1 className="mt-5 text-[clamp(2rem,4vw,3rem)] font-semibold tracking-[-0.04em]">
          No route for /{route}
        </h1>
        <p className="mt-4 max-w-[46ch] text-[15px] text-[var(--color-fg-muted)]">
          That page is not in the fleet. The scheduler could not find an eligible node.
        </p>
        <div className="mt-8 flex gap-4">
          <a href="#top" className="link-draw font-mono text-[12px] text-[var(--color-signal)]">
            back to the landing page
          </a>
          <a href="#/docs" className="link-draw font-mono text-[12px] text-[var(--color-fg-muted)]">
            documentation
          </a>
        </div>
      </div>
    )
  }

  const idx = PAGE_ORDER.indexOf(route)
  const prev = idx > 0 ? PAGE_ORDER[idx - 1] : null
  const next = idx >= 0 && idx < PAGE_ORDER.length - 1 ? PAGE_ORDER[idx + 1] : null

  return (
    <article className="relative">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[340px] dot-bg opacity-40" />

      {/* header */}
      <header className="rail relative border-b border-[var(--color-line)] pb-12 pt-28 lg:pt-32">
        <Reveal className="flex items-center gap-2.5 font-mono text-[11px]" y={8} duration={0.5}>
          <a href="#top" className="link-draw text-[var(--color-fg-dim)] hover:text-[var(--color-fg-muted)]">
            fleet·os
          </a>
          <span className="text-[var(--color-line-2)]">/</span>
          <span className="text-[var(--color-fg-dim)]">{page.group}</span>
          <span className="text-[var(--color-line-2)]">/</span>
          <span className="text-[var(--color-signal)]">{page.kicker}</span>
        </Reveal>

        <Reveal i={1}>
          <h1 className="mt-6 text-[clamp(2.1rem,4.6vw,3.3rem)] font-semibold leading-[1.02] tracking-[-0.04em] text-balance">
            {page.title}
          </h1>
        </Reveal>

        <Reveal i={2}>
          <p className="mt-5 max-w-[62ch] text-[15.5px] leading-[1.7] text-[var(--color-fg-muted)] text-pretty">
            {page.lede}
          </p>
        </Reveal>

        <Reveal i={3} className="mt-8 flex items-center gap-2.5 font-mono text-[10.5px] text-[var(--color-fg-dim)]">
          <StatusDot size={5} tone={page.updated === 'live' ? 'online' : 'idle'} />
          last updated {page.updated}
        </Reveal>
      </header>

      {/* body + table of contents */}
      <div className="rail relative grid gap-12 py-14 lg:grid-cols-12 lg:py-16">
        <main ref={mainRef} className="min-w-0 lg:col-span-8">
          {page.blocks.map((b, i) => (
            <Block key={i} b={b} />
          ))}

          {/* prev / next */}
          {(prev || next) && (
            <nav className="mt-16 grid gap-px border-t border-[var(--color-line)] bg-[var(--color-line)] pt-px sm:grid-cols-2">
              {[['previous', prev], ['next', next]].map(([label, key]) =>
                key ? (
                  <motion.a
                    key={label}
                    href={`#/${key}`}
                    whileHover={{ y: -2 }}
                    transition={{ type: 'spring', stiffness: 300, damping: 24 }}
                    className={`group bg-[var(--color-ink-950)] p-5 transition-colors duration-400 hover:bg-[var(--color-ink-900)] ${
                      label === 'next' ? 'sm:text-right' : ''
                    }`}
                  >
                    <span className="mono-label">{label}</span>
                    <div className="mt-2 text-[15px] font-medium tracking-[-0.02em] text-[var(--color-fg)] transition-colors duration-300 group-hover:text-[var(--color-signal)]">
                      {PAGES[key].title}
                    </div>
                  </motion.a>
                ) : (
                  <span key={label} className="hidden bg-[var(--color-ink-950)] sm:block" />
                )
              )}
            </nav>
          )}
        </main>

        {/* sticky contents rail */}
        {toc.length > 1 && (
          <aside className="hidden lg:col-span-3 lg:col-start-10 lg:block">
            <div className="sticky top-24">
              <span className="mono-label">on this page</span>
              <ul className="mt-5 space-y-2.5 border-l border-[var(--color-line)]">
                {toc.map((h) => {
                  const id = slug(h)
                  const active = activeId === id
                  return (
                    <li key={h} className="relative">
                      {active && (
                        <motion.span
                          layoutId="toc-marker"
                          className="absolute -left-px top-0 h-full w-px bg-[var(--color-signal)]"
                          transition={{ duration: 0.35, ease: EASE.expo }}
                        />
                      )}
                      <a
                        href={`#${id}`}
                        onClick={(e) => {
                          e.preventDefault()
                          document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                        }}
                        className={`block py-0.5 pl-4 text-[12.5px] leading-snug transition-colors duration-300 ${
                          active
                            ? 'text-[var(--color-fg)]'
                            : 'text-[var(--color-fg-dim)] hover:text-[var(--color-fg-muted)]'
                        }`}
                      >
                        {h}
                      </a>
                    </li>
                  )
                })}
              </ul>

              <div className="mt-8 border-t border-[var(--color-line)] pt-6">
                <span className="mono-label">elsewhere</span>
                <ul className="mt-4 space-y-2">
                  {[
                    ['Documentation', '#/docs'],
                    ['CLI reference', '#/docs/cli'],
                    ['REST API', '#/docs/api'],
                    ['Changelog', '#/changelog'],
                  ]
                    .filter(([, h]) => h !== `#/${route}`)
                    .map(([label, href]) => (
                      <li key={href}>
                        <a
                          href={href}
                          className="link-draw text-[12.5px] text-[var(--color-fg-dim)] transition-colors duration-300 hover:text-[var(--color-fg)]"
                        >
                          {label}
                        </a>
                      </li>
                    ))}
                </ul>
              </div>
            </div>
          </aside>
        )}
      </div>
    </article>
  )
}
