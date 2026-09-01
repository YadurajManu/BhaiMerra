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
 * Note it does NOT fix link previews: with hash routing the fragment is never
 * sent to the server, so a crawler fetching fleet-os.dev/#/docs/cli only ever
 * sees the homepage HTML. Per-page cards need real paths and prerendering.
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

    const url = route === null ? 'https://fleet-os.dev/' : `https://fleet-os.dev/#/${route}`
    setMeta('meta[property="og:url"]', url)
    document.head.querySelector('link[rel="canonical"]')?.setAttribute('href', url)
  }, [route])
}
