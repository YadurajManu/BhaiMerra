import { useEffect, useState } from 'react'

// Hash routing: no server config, works from a static bucket, and keeps the
// landing page a plain anchor-scroll document.
export function currentRoute() {
  const h = window.location.hash || ''
  if (!h.startsWith('#/')) return null // landing page (incl. #section anchors)
  return h.slice(2).replace(/\/+$/, '') || 'home'
}

export function useRoute() {
  const [route, setRoute] = useState(() => currentRoute())

  useEffect(() => {
    const onHash = () => setRoute(currentRoute())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  return route
}

export function navigate(path) {
  window.location.hash = path
}
