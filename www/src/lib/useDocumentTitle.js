import { useEffect } from 'react'
import { PAGES } from './pages'

const HOME_TITLE = 'Fleet OS — git push to hardware you already own'
const HOME_DESC =
  'Fleet OS turns the Raspberry Pi, old laptop and spare mini PC you already own into one resilient deploy target. Multi-arch builds, constraint-based placement, encrypted mesh, automatic failover.'

/**
 * Routes that render their own component rather than a PAGES entry. Without
 * this they resolve to no page and get titled "Not found", which is a bad
 * thing for a browser tab to say about a page that exists.
 */
const STANDALONE = {
  founder: {
    title: 'Yaduraj Singh',
    lede:
      'Fleet OS is built and maintained by one person. Why it exists, what running it alone can and cannot give you, and how to get hold of me.',
  },
}

function setMeta(selector, value) {
  const el = document.head.querySelector(selector)
  if (el) el.setAttribute('content', value)
}

/**
 * Per-route title and description. This is what browser tabs, history entries
 * and bookmarks read — all twenty routes reported the same string before.
 *
 * These are the client-side values. The authoritative copies are baked into
 * each prerendered file at build time by scripts/prerender.mjs — a crawler
 * that never runs the JavaScript still gets the right title, description and
 * canonical, and one that does run it gets the same answer.
 */
export function useDocumentTitle(route) {
  useEffect(() => {
    const page = route === null ? null : (PAGES[route] ?? STANDALONE[route])

    if (page) {
      document.title = `${page.title} — Fleet OS`
      setMeta('meta[name="description"]', page.lede)
      setMeta('meta[property="og:title"]', `${page.title} — Fleet OS`)
      setMeta('meta[property="og:description"]', page.lede)
    } else if (route !== null) {
      document.title = 'Not found — Fleet OS'
      setMeta('meta[name="description"]', HOME_DESC)
    } else {
      document.title = HOME_TITLE
      setMeta('meta[name="description"]', HOME_DESC)
      setMeta('meta[property="og:title"]', 'Fleet OS — your hardware, orchestrated like a platform')
      setMeta('meta[property="og:description"]', HOME_DESC)
    }

    // Real paths, matching the prerendered files. A canonical pointing at the
    // hash form would tell a crawler the authoritative copy lives at a URL whose
    // content it can never fetch.
    const url =
      route === null
        ? 'https://fleet.plastikworld.xyz/'
        : `https://fleet.plastikworld.xyz/${route}`
    setMeta('meta[property="og:url"]', url)
    document.head.querySelector('link[rel="canonical"]')?.setAttribute('href', url)
  }, [route])
}
