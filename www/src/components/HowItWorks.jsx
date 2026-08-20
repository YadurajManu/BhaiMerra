import { useRef, useState, useEffect } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { STEPS } from '../lib/data'
import { EASE } from '../lib/motion'
import SectionHead from './ui/SectionHead'
import StepVisual from './StepVisuals'

function Step({ step, index, onActive, active }) {
  const ref = useRef(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      ([e]) => e.isIntersecting && onActive(index),
      { rootMargin: '-45% 0px -45% 0px', threshold: 0 }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [index, onActive])

  return (
    <div ref={ref} className="min-w-0 py-10 lg:py-[9vh]">
      <motion.div
        animate={{ opacity: active ? 1 : 0.34 }}
        transition={{ duration: 0.55, ease: EASE.glide }}
        className="min-w-0 lg:pl-10"
      >
        <div className="flex items-center gap-3">
          <span
            className={`font-mono text-[11px] transition-colors duration-500 ${
              active ? 'text-[var(--color-signal)]' : 'text-[var(--color-fg-dim)]'
            }`}
          >
            {step.n}
          </span>
          <span className="mono-label">{step.kicker}</span>
        </div>
        <h3 className="mt-4 max-w-[19ch] text-[clamp(1.35rem,2.5vw,1.95rem)] font-semibold leading-[1.12] tracking-[-0.032em] text-balance">
          {step.title}
        </h3>
        <p className="mt-4 max-w-[46ch] text-[14.5px] leading-[1.65] text-[var(--color-fg-muted)] text-pretty">
          {step.body}
        </p>
        <div className="mt-5 max-w-[46ch] border-l border-[var(--color-line-2)] py-1 pl-3 font-mono text-[11px] leading-relaxed break-words text-[var(--color-fg-dim)]">
          {step.code}
        </div>

        {/* on narrow viewports the visual belongs with its step, not in a rail */}
        <div className="mt-6 min-w-0 lg:hidden">
          <StepVisual index={index} />
        </div>
      </motion.div>
    </div>
  )
}

export default function HowItWorks() {
  const [active, setActive] = useState(0)
  const reduce = useReducedMotion()

  return (
    <section id="how" className="relative border-b border-[var(--color-line)]">
      <div className="rail pt-24 lg:pt-32">
        <SectionHead
          index="01"
          kicker="how it works"
          title="Six moving parts, and you touch two of them."
          lede="Register the machines, then push. Everything between build and live URL is the control plane's job — and it is the part that gets hard the moment your fleet stops being one always-on box."
          max="max-w-[46ch]"
        />
      </div>

      <div className="rail relative grid gap-x-12 pb-24 lg:grid-cols-2 lg:pb-32">
        {/* left: the steps, with a progress rail that tracks the active one */}
        <div className="relative min-w-0">
          <div className="absolute left-[3px] top-0 hidden h-full w-px bg-[var(--color-line)] lg:block">
            <motion.div
              className="absolute left-0 w-px bg-[var(--color-signal)]"
              animate={{
                top: `${(active / STEPS.length) * 100}%`,
                height: `${(1 / STEPS.length) * 100}%`,
              }}
              transition={{ duration: 0.6, ease: EASE.expo }}
            />
          </div>
          {STEPS.map((s, i) => (
            <Step key={s.n} step={s} index={i} active={active === i} onActive={setActive} />
          ))}
        </div>

        {/* right: one sticky panel, contents swap with the active step */}
        <div className="hidden lg:block">
          <div className="sticky top-[calc(50vh-230px)] h-[460px]">
            <div className="relative h-full">
              <AnimatePresence mode="wait">
                <motion.div
                  key={active}
                  initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14, filter: 'blur(4px)' }}
                  animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, y: -10, filter: 'blur(4px)' }}
                  transition={{ duration: 0.45, ease: EASE.expo }}
                  className="absolute inset-0"
                >
                  <StepVisual index={active} />
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
