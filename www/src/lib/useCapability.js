import { useEffect, useState } from 'react'

function webglSupported() {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl'))
  } catch {
    return false
  }
}

/**
 * The 3D scene is the enhancement, not the baseline. Anything that says
 * "don't" — reduced motion, no WebGL, a very low core count, save-data —
 * gets the static graph instead.
 */
export function useCanRender3D() {
  const [ok, setOk] = useState(false)

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const cores = navigator.hardwareConcurrency ?? 8
    const saveData = navigator.connection?.saveData === true
    setOk(!reduce && !saveData && cores > 2 && webglSupported())
  }, [])

  return ok
}

// Shared handle so UI that must freeze the page (the mobile menu) can stop
// Lenis rather than fighting it with overflow rules.
export const lenisRef = { current: null }

export function useSmoothScroll() {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let lenis
    let raf
    let onClick
    let cancelled = false

    import('lenis').then(({ default: Lenis }) => {
      if (cancelled) return
      lenis = new Lenis({
        duration: 1.05,
        easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
        touchMultiplier: 1.4,
      })
      lenisRef.current = lenis
      const loop = (time) => {
        lenis.raf(time)
        raf = requestAnimationFrame(loop)
      }
      raf = requestAnimationFrame(loop)

      // Let in-page anchors ride the same inertia. Delegated, so it keeps
      // working after a route change, and it ignores router hashes (#/docs)
      // and heading anchors handled elsewhere.
      onClick = (e) => {
        const a = e.target.closest?.('a[href^="#"]')
        if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return
        const href = a.getAttribute('href')
        if (!href || href === '#' || href.startsWith('#/')) return
        const el = document.getElementById(href.slice(1))
        if (!el) return
        e.preventDefault()
        lenis.scrollTo(el, { offset: -72 })
      }
      document.addEventListener('click', onClick)
    })

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      if (onClick) document.removeEventListener('click', onClick)
      lenisRef.current = null
      lenis?.destroy()
    }
  }, [])
}
