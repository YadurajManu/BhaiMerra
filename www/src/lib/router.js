import { useEffect, useState } from 'react'
import { PAGES } from './pages'

/**
 * Routing on real paths, with hash routing still honoured.
 *
 * Hash routing was chosen because it needs no server config and works from a
 * static bucket. The cost is that everything after `#` is never sent to the
 * server, so a crawler asking for /docs/fleet-yaml receives the same empty
 * shell and the same <title> as the homepage — twenty pages of documentation
 * that, as far as a search engine is concerned, do not exist.
 *
 * So paths are now primary and prerendered at build time, and `#/route` is
 * still accepted: every link already published, in every README and every
 * shared message, keeps working.
 */

function fromPath(pathname) {
  const clean = pathname.replace(/^\/+|\/+$/g, '')
  if (!clean) return null
  return PAGES[clean] || clean === 'founder' ? clean : null
}

export function currentRoute() {
  const h = window.location.hash || ''
  // An explicit #/route wins: it is what the reader clicked.
  if (h.startsWith('#/')) return h.slice(2).replace(/\/+$/, '') || 'home'
  // A plain #section anchor on the landing page is not a route.
  if (h && !h.startsWith('#/')) return fromPath(window.location.pathname)
  return fromPath(window.location.pathname)
}

export function useRoute() {
  const [route, setRoute] = useState(() => currentRoute())

  useEffect(() => {
    const sync = () => setRoute(currentRoute())
    window.addEventListener('hashchange', sync)
    // Back and forward have to work now that navigation is not only the hash.
    window.addEventListener('popstate', sync)
    return () => {
      window.removeEventListener('hashchange', sync)
      window.removeEventListener('popstate', sync)
    }
  }, [])

  return route
}

export function navigate(path) {
  const clean = String(path).replace(/^#?\/?/, '')
  window.history.pushState({}, '', `/${clean}`)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

/**
 * Turn an in-app href into a real path so links are crawlable and shareable.
 * A `#section` anchor on the landing page is left alone — it is a scroll
 * target, not a route.
 */
export function hrefFor(href) {
  if (typeof href !== 'string') return href
  if (href.startsWith('#/')) return `/${href.slice(2)}`
  return href
}
