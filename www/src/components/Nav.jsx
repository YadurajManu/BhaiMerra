import { useEffect, useState } from 'react'
import { APP_URL } from '../lib/data'
import { motion } from 'framer-motion'
import { EASE } from '../lib/motion'
import StatusDot from './ui/StatusDot'
import Logo from './ui/Logo'
import MobileMenu, { MenuToggle } from './MobileMenu'

const LANDING_LINKS = [
  ['How it works', '#how'],
  ['Failover', '#failover'],
  ['Compare', '#compare'],
  ['CLI', '#cli'],
  ['Pricing', '#pricing'],
]

// On a sub-page the section anchors are meaningless, so the nav becomes a
// map of the docs instead of a map of the landing page.
const PAGE_LINKS = [
  ['Docs', '#/docs'],
  ['CLI', '#/docs/cli'],
  ['API', '#/docs/api'],
  ['Changelog', '#/changelog'],
  ['Pricing', '#top'],
]

export default function Nav({ onPage = false }) {
  const [solid, setSolid] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const links = onPage ? PAGE_LINKS : LANDING_LINKS

  // A route change should never leave the menu hanging open behind the page.
  useEffect(() => {
    const close = () => setMenuOpen(false)
    window.addEventListener('hashchange', close)
    return () => window.removeEventListener('hashchange', close)
  }, [])

  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 24)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <motion.header
      initial={{ y: -28, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.8, ease: EASE.expo, delay: 0.1 }}
      className={`fixed inset-x-0 top-0 z-50 border-b transition-colors duration-500 ${
        menuOpen
          ? 'border-[var(--color-line)] bg-[var(--color-ink-950)]'
          : solid
          ? 'border-[var(--color-line)] bg-[color-mix(in_oklab,var(--color-ink-950)_82%,transparent)] backdrop-blur-md'
            : 'border-transparent'
      }`}
    >
      <div className="rail flex h-[58px] items-center justify-between">
        <a href="#top" className="group flex items-center">
          <Logo size={18} word animate />
        </a>

        <nav className="hidden items-center gap-7 md:flex">
          {links.map(([label, href]) => (
            <a
              key={href}
              href={href}
              className="link-draw font-mono text-[11.5px] tracking-[0.02em] text-[var(--color-fg-muted)] transition-colors duration-300 hover:text-[var(--color-fg)]"
            >
              {label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2 sm:gap-4">
          <span className="hidden items-center gap-1.5 font-mono text-[10.5px] text-[var(--color-fg-dim)] lg:flex">
            <StatusDot size={5} />
            <a href="#/changelog" className="link-draw">v0.9.2 · beta</a>
          </span>
          <a
            href={APP_URL}
            className="hidden rounded-[3px] border border-[var(--color-line-2)] px-3.5 py-[7px] font-mono text-[11.5px] sm:inline-block text-[var(--color-fg)] transition-all duration-300 hover:border-[var(--color-signal)] hover:text-[var(--color-signal)]"
          >
            Get started
          </a>

          <MenuToggle open={menuOpen} onClick={() => setMenuOpen((v) => !v)} />
        </div>
      </div>

      <MobileMenu open={menuOpen} onClose={() => setMenuOpen(false)} />
    </motion.header>
  )
}
