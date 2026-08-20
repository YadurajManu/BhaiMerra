import { useEffect, useRef } from 'react'
import { NODES, EDGES } from '../lib/graph'

/**
 * The footer's quiet twin of the hero graph: same topology, smaller, dimmer,
 * drifting slower. It powers on when the footer scrolls in rather than being
 * there the whole time — the fleet is still running as the page winds down.
 */
export default function AmbientMesh({ className = '' }) {
  const canvasRef = useRef(null)
  const wrapRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ctx = canvas.getContext('2d')
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let w = 0
    let h = 0
    let dpr = Math.min(window.devicePixelRatio || 1, 2)
    let power = 0
    let visible = false
    let raf = 0
    let t0 = performance.now()

    // A slightly denser field than the hero: extra drifting peers in the deep bg.
    const extra = [
      [-2.6, 1.25], [2.55, 1.1], [-1.15, -1.5], [1.65, -1.35], [0.05, 1.5],
    ]
    const pts = [
      ...NODES.map((n, i) => ({ x: n.p[0], y: n.p[1], r: n.r * 34, live: !!n.live, ph: i * 1.31 })),
      ...extra.map(([x, y], i) => ({ x, y, r: 1.9, live: false, ph: 3 + i * 0.9 })),
    ]

    const resize = () => {
      const rect = wrap.getBoundingClientRect()
      w = rect.width
      h = rect.height
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    // world → canvas. Wider than it is tall, and sunk below the link columns:
    // the graph lives in the empty band at the bottom of the footer so it
    // never competes with the links sitting on top of it.
    const sX = () => Math.min(Math.max(w / 9.5, 88), 190)
    const sY = () => Math.min(sX() * 0.55, h / 5.2)
    const px = (x) => w * 0.5 + x * sX()
    const py = (y) => h * 0.76 - y * sY()

    const draw = (now) => {
      // Under reduced motion the graph is painted once, at rest, and the loop
      // stops. Otherwise it idles cheaply while the footer is off screen.
      if (!reduce) raf = requestAnimationFrame(draw)
      if (!visible) return

      // frozen clock under reduced motion: no drift, no beat, no ping
      const t = reduce ? 0 : (now - t0) / 1000
      // time-based, not frame-based: the power-on takes 1.4s whether the page
      // is running at 120fps or being throttled to a crawl
      power = reduce ? 1 : Math.min(1, t / 1.4)
      ctx.clearRect(0, 0, w, h)

      const live = pts.map((p) => ({
        ...p,
        cx: px(p.x + Math.sin(t * 0.11 + p.ph) * 0.075),
        cy: py(p.y + Math.cos(t * 0.09 + p.ph * 1.2) * 0.075),
      }))

      ctx.lineWidth = 1
      EDGES.forEach(([a, b], i) => {
        const A = live[a]
        const B = live[b]
        const wave = 0.5 + 0.5 * Math.sin(t * 0.4 + i)
        ctx.strokeStyle = `rgba(133,150,168,${0.16 * power * (0.5 + wave * 0.5)})`
        ctx.beginPath()
        ctx.moveTo(A.cx, A.cy)
        ctx.lineTo(B.cx, B.cy)
        ctx.stroke()
      })

      live.forEach((p, i) => {
        const beat = p.live ? 0.5 + 0.5 * Math.sin(t * 2.6) : 0
        ctx.beginPath()
        ctx.arc(p.cx, p.cy, p.r, 0, Math.PI * 2)
        ctx.fillStyle = p.live
          ? `rgba(63,224,139,${(0.42 + beat * 0.22) * power})`
          : `rgba(150,163,178,${(0.24 + (i % 3) * 0.05) * power})`
        ctx.fill()

        if (p.live) {
          const ping = ((t * 0.42) % 1)
          ctx.beginPath()
          ctx.arc(p.cx, p.cy, p.r + ping * 34, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(63,224,139,${0.22 * (1 - ping) * power})`
          ctx.stroke()
        }
      })

    }

    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(wrap)

    const io = new IntersectionObserver(
      ([e]) => {
        const entering = e.isIntersecting && !visible
        visible = e.isIntersecting
        // power on from zero each time the footer comes back into view
        if (entering) {
          t0 = performance.now()
          if (reduce) draw(t0)
        }
      },
      { threshold: 0.05 }
    )
    io.observe(wrap)

    if (!reduce) raf = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(raf)
      io.disconnect()
      ro.disconnect()
    }
  }, [])

  return (
    <div ref={wrapRef} className={`pointer-events-none ${className}`} aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  )
}
