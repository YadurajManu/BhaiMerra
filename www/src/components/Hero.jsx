import { useRef, useState, useEffect, lazy, Suspense } from 'react'
import { motion, useScroll, useTransform, useReducedMotion } from 'framer-motion'
import { EASE } from '../lib/motion'
import { useCanRender3D } from '../lib/useCapability'
import MeshStatic from './MeshStatic'
import MagneticButton from './ui/MagneticButton'
import CopyLine from './ui/CopyLine'
import StatusDot from './ui/StatusDot'
import NodeHUD from './NodeHUD'

const MeshScene = lazy(() => import('./MeshScene'))

/*
  Headline candidates considered:
   A. "Your hardware. Orchestrated like a platform."   <- shipped
   B. "git push to the machines under your desk."
   C. "Stop renting compute you already own."
  A carries the tension the whole page is about; B is narrower, C is a
  complaint rather than a proposition.
*/

const STATS = [
  ['agent footprint', '< 50 MB'],
  ['architectures', 'arm64 · armv7 · amd64'],
  ['reschedule after heartbeat loss', '~4 s'],
  ['ports forwarded', '0'],
]

export default function Hero() {
  const ref = useRef(null)
  const sceneRef = useRef(null)
  const can3D = useCanRender3D()
  const reduce = useReducedMotion()
  const [sceneActive, setSceneActive] = useState(true)

  useEffect(() => {
    const el = sceneRef.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setSceneActive(e.isIntersecting), {
      threshold: 0,
    })
    io.observe(el)
    return () => io.disconnect()
  }, [can3D])

  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ['start start', 'end start'],
  })
  // The scene recedes rather than being cut off at the section edge.
  const vOpacity = useTransform(scrollYProgress, [0, 0.75], [1, 0])
  const vScale = useTransform(scrollYProgress, [0, 1], [1, 0.86])
  const vY = useTransform(scrollYProgress, [0, 1], [0, -70])
  const copyY = useTransform(scrollYProgress, [0, 1], [0, 48])

  return (
    <section
      id="top"
      ref={ref}
      className="relative flex min-h-[calc(100svh-58px)] flex-col overflow-hidden pt-[58px]"
    >
      {/* structural grid, not decoration: the coordinate space the graph sits in */}
      <div className="pointer-events-none absolute inset-0 grid-bg opacity-70" />
      {/* a single soft pool of light behind the live node — no floating blobs */}
      <div
        className="pointer-events-none absolute right-[6%] top-[26%] hidden h-[520px] w-[520px] lg:block"
        style={{
          background:
            'radial-gradient(circle, color-mix(in oklab, var(--color-signal) 9%, transparent) 0%, transparent 64%)',
        }}
      />

      <div className="rail relative flex flex-1 items-center">
        <div className="grid w-full items-center gap-y-14 py-16 lg:grid-cols-12 lg:gap-x-8 lg:py-10">
          {/* ── copy column ─────────────────────────────────────────── */}
          <motion.div
            style={reduce ? undefined : { y: copyY }}
            className="relative z-10 lg:col-span-6 xl:col-span-5"
          >
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, ease: EASE.expo, delay: 0.15 }}
              className="inline-flex items-center gap-2.5 border border-[var(--color-line)] bg-[var(--color-ink-900)] px-3 py-1.5"
            >
              <StatusDot size={6} />
              <span className="font-mono text-[10.5px] tracking-[0.1em] text-[var(--color-fg-muted)]">
                6 NODES · 3 ARCHES · 1 MESH
              </span>
            </motion.div>

            <h1 className="mt-7 text-[clamp(2.5rem,5.4vw,4.15rem)] font-semibold leading-[0.95] tracking-[-0.045em]">
              {['Your hardware.', 'Orchestrated'].map((line, i) => (
                <motion.span
                  key={line}
                  className="block"
                  initial={reduce ? { opacity: 0 } : { opacity: 0, y: 26 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.9, ease: EASE.expo, delay: 0.2 + i * 0.09 }}
                >
                  {line}
                </motion.span>
              ))}
              <motion.span
                className="block text-[var(--color-fg-dim)]"
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 26 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.9, ease: EASE.expo, delay: 0.38 }}
              >
                like a platform.
              </motion.span>
            </h1>

            <motion.p
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, ease: EASE.expo, delay: 0.5 }}
              className="mt-6 max-w-[40ch] text-[15px] leading-[1.62] text-[var(--color-fg-muted)] text-pretty"
            >
              git push to the Pi, the old laptop and the spare mini PC you already own.
              Fleet OS builds for every architecture in the room, places each service on
              the node that can actually run it, and moves it when that node goes dark.
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, ease: EASE.expo, delay: 0.6 }}
              className="mt-8 flex flex-wrap items-center gap-3"
            >
              <MagneticButton href="#pricing" variant="primary">
                Get started
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M3 8h9m0 0L8.5 4.5M12 8l-3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </MagneticButton>
              <MagneticButton href="#/docs" variant="ghost" strength={0.18}>
                Read the docs
              </MagneticButton>
              <a
                href="#/community"
                className="link-draw ml-1 font-mono text-[11.5px] text-[var(--color-fg-dim)] transition-colors duration-300 hover:text-[var(--color-fg-muted)]"
              >
                github ↗
              </a>
            </motion.div>

            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.9, ease: EASE.expo, delay: 0.75 }}
              className="mt-5 max-w-[440px]"
            >
              <CopyLine command="curl -fsSL fleet-os.dev/install | sh" />
              <p className="mt-2.5 font-mono text-[10px] tracking-[0.06em] text-[var(--color-fg-dim)]">
                one line per machine · arm64 · armv7 · amd64
              </p>
            </motion.div>
          </motion.div>

          {/* ── graph column ────────────────────────────────────────── */}
          <div className="relative lg:col-span-6 xl:col-span-7">
            <motion.div
              ref={sceneRef}
              style={reduce ? undefined : { opacity: vOpacity, scale: vScale, y: vY }}
              // the left edge fades out so the graph never fights the headline
              className="relative h-[320px] sm:h-[400px] lg:absolute lg:-right-[6vw] lg:top-1/2 lg:h-[74vh] lg:max-h-[720px] lg:w-[62vw] lg:-translate-y-1/2 [mask-image:linear-gradient(to_right,transparent,black_26%)]"
            >
              {can3D ? (
                <Suspense fallback={<MeshStatic />}>
                  <MeshScene active={sceneActive} />
                </Suspense>
              ) : (
                <MeshStatic />
              )}
            </motion.div>

            {/* live readout for the node that is pulsing in the graph */}
            <div className="mt-8 flex justify-center lg:mt-0 lg:absolute lg:right-0 lg:top-[calc(50%+150px)] lg:block">
              <NodeHUD />
            </div>
          </div>
        </div>
      </div>

      {/* stats rail — reads as a status bar, closes the viewport */}
      <div className="relative z-10 border-t border-[var(--color-line)] bg-[var(--color-ink-950)]">
        <div className="rail grid grid-cols-2 divide-[var(--color-line)] lg:grid-cols-4 lg:divide-x">
          {STATS.map(([label, value], i) => (
            <motion.div
              key={label}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, ease: EASE.expo, delay: 0.85 + i * 0.07 }}
              className="border-b border-[var(--color-line)] px-1 py-4 lg:border-b-0 lg:px-6 lg:py-5 lg:first:pl-0"
            >
              <div className="font-mono text-[14px] tracking-[-0.01em] text-[var(--color-fg)] lg:text-[15px]">
                {value}
              </div>
              <div className="mono-label mt-1.5 normal-case tracking-[0.08em]">{label}</div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}
