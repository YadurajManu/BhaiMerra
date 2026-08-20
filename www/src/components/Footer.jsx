import { useEffect, useRef, useState } from 'react'
import { motion, useInView, useReducedMotion } from 'framer-motion'
import { FOOTER_LINKS, LEGAL_LINKS } from '../lib/data'
import { EASE } from '../lib/motion'
import AmbientMesh from './AmbientMesh'
import StatusDot from './ui/StatusDot'
import Logo from './ui/Logo'
import CopyLine from './ui/CopyLine'

function useTicker() {
  const [n, setN] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setN((v) => v + 1), 1000)
    return () => clearInterval(id)
  }, [])
  return n
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400)
  const h = String(Math.floor((sec % 86400) / 3600)).padStart(2, '0')
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0')
  const s = String(sec % 60).padStart(2, '0')
  return `${d}d ${h}:${m}:${s}`
}

/* A link that draws its underline in from the left and nudges on hover. */
function FooterLink({ label, href }) {
  const external = href.startsWith('http')
  return (
    <a
      href={href}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      className="group inline-flex items-center gap-1.5 text-[13px] text-[var(--color-fg-muted)] transition-colors duration-300 hover:text-[var(--color-fg)]"
    >
      <span className="link-draw">{label}</span>
      <motion.span
        aria-hidden="true"
        className="font-mono text-[10px] text-[var(--color-signal)] opacity-0 transition-opacity duration-300 group-hover:opacity-100"
      >
        {external ? '↗' : '→'}
      </motion.span>
    </a>
  )
}

function BackToTop() {
  return (
    <motion.a
      href="#top"
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.94 }}
      transition={{ type: 'spring', stiffness: 380, damping: 24 }}
      className="group inline-flex items-center gap-2 border border-[var(--color-line-2)] px-3 py-2 font-mono text-[10.5px] text-[var(--color-fg-muted)] transition-colors duration-300 hover:border-[var(--color-signal)] hover:text-[var(--color-signal)]"
    >
      <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path
          d="M6 10V2m0 0L2.5 5.5M6 2l3.5 3.5"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      back to top
    </motion.a>
  )
}

export default function Footer() {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true, amount: 0.1 })
  const reduce = useReducedMotion()
  const tick = useTicker()

  // Plausible control-plane readout. Simulated on a marketing page, but it
  // ticks the way the real one does.
  const uptime = 41 * 86400 + 6 * 3600 + 12 * 60 + 38 + tick
  const sinceDeploy = 14 + tick

  const rise = (delay = 0) => ({
    initial: reduce ? { opacity: 0 } : { opacity: 0, y: 22 },
    animate: inView ? { opacity: 1, y: 0 } : {},
    transition: { duration: 0.8, delay, ease: EASE.expo },
  })

  return (
    <footer
      ref={ref}
      className="relative overflow-hidden border-t border-[var(--color-line)] bg-[var(--color-ink-950)]"
    >
      <AmbientMesh className="absolute inset-0" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-[var(--color-ink-950)] to-transparent" />

      {/* ── status strip ─────────────────────────────────────────── */}
      <div className="relative border-b border-[var(--color-line)]">
        <div className="rail flex flex-wrap items-center justify-between gap-y-3 py-4">
          <motion.a
            href="#/status"
            {...rise(0)}
            className="group flex items-center gap-2.5"
          >
            <StatusDot size={7} />
            <span className="font-mono text-[11.5px] text-[var(--color-fg)]">
              <span className="link-draw">All systems operational</span>
            </span>
            <span className="hidden font-mono text-[11px] text-[var(--color-fg-dim)] sm:inline">
              · control plane · mesh coordinator · registry · build runners
            </span>
          </motion.a>

          <motion.div
            {...rise(0.08)}
            className="flex items-center gap-6 font-mono text-[10.5px] text-[var(--color-fg-dim)]"
          >
            <span>
              uptime{' '}
              <span className="tabular-nums text-[var(--color-fg-muted)]">{fmtUptime(uptime)}</span>
            </span>
            <span className="hidden sm:inline">
              last deploy{' '}
              <span className="tabular-nums text-[var(--color-fg-muted)]">{sinceDeploy}s ago</span>
            </span>
          </motion.div>
        </div>
      </div>

      {/* ── main body ────────────────────────────────────────────── */}
      <div className="rail relative grid gap-12 py-16 lg:grid-cols-12 lg:gap-8 lg:py-20">
        {/* identity block */}
        <motion.div {...rise(0)} className="lg:col-span-4">
          <a href="#top" className="inline-block">
            <Logo size={30} word tagline animate />
          </a>

          <p className="mt-6 max-w-[36ch] text-[13px] leading-[1.7] text-[var(--color-fg-muted)] text-pretty">
            git-push deploys onto the Pi, the old laptop and the spare mini PC you
            already own. Multi-arch builds, constraint-based placement, an encrypted
            mesh, and failover that knows the difference between a web server and a
            database.
          </p>

          <div className="mt-7 max-w-[400px]">
            <CopyLine command="curl -fsSL fleet-os.dev/install | sh" />
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2 border border-[var(--color-line)] px-3 py-1.5 font-mono text-[10.5px] text-[var(--color-fg-dim)]">
              <StatusDot size={5} />
              v0.9.2 · open beta
            </span>
            <a
              href="#/legal/licence"
              className="link-draw font-mono text-[10.5px] text-[var(--color-fg-dim)] transition-colors duration-300 hover:text-[var(--color-fg-muted)]"
            >
              self-hosting available
            </a>
          </div>
        </motion.div>

        {/* link columns */}
        <div className="grid gap-10 sm:grid-cols-2 lg:col-span-7 lg:col-start-6 lg:grid-cols-4">
          {FOOTER_LINKS.map((col, ci) => (
            <motion.div key={col.heading} {...rise(0.12 + ci * 0.085)}>
              <h3 className="mono-label">{col.heading}</h3>
              <span className="mt-3 block h-px w-6 bg-[var(--color-line-2)]" />
              <ul className="mt-5 space-y-3">
                {col.links.map(([label, href]) => (
                  <li key={label + href}>
                    <FooterLink label={label} href={href} />
                  </li>
                ))}
              </ul>
            </motion.div>
          ))}
        </div>
      </div>

      {/* ── bottom bar ───────────────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={inView ? { opacity: 1 } : {}}
        transition={{ duration: 0.7, delay: 0.5, ease: EASE.expo }}
        className="relative border-t border-[var(--color-line)]"
      >
        <div className="rail flex flex-wrap items-center justify-between gap-y-4 py-5">
          <span className="font-mono text-[10.5px] text-[var(--color-fg-dim)]">
            © 2026 Fleet OS. Built by people with too many Raspberry Pis.
          </span>

          <div className="flex flex-wrap items-center gap-5">
            {LEGAL_LINKS.map(([label, href]) => (
              <a
                key={label}
                href={href}
                className="link-draw font-mono text-[10.5px] text-[var(--color-fg-dim)] transition-colors duration-300 hover:text-[var(--color-fg-muted)]"
              >
                {label}
              </a>
            ))}
            <span className="flex items-center gap-2 font-mono text-[10.5px] text-[var(--color-fg-dim)]">
              <StatusDot size={5} />
              fleet-os.dev
            </span>
            <BackToTop />
          </div>
        </div>
      </motion.div>
    </footer>
  )
}
