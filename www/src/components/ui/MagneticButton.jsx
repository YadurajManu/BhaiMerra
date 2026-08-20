import { useRef } from 'react'
import { motion, useMotionValue, useSpring, useReducedMotion } from 'framer-motion'
import { SPRING } from '../../lib/motion'

/**
 * Cursor-following pull on hover, real press state on pointer-down.
 * The pull is capped low on purpose — it should read as weight, not as a toy.
 */
export default function MagneticButton({
  children,
  href = '#',
  variant = 'primary',
  strength = 0.28,
  className = '',
  ...rest
}) {
  const ref = useRef(null)
  const reduce = useReducedMotion()
  const mx = useMotionValue(0)
  const my = useMotionValue(0)
  const x = useSpring(mx, SPRING.magnet)
  const y = useSpring(my, SPRING.magnet)

  function onMove(e) {
    if (reduce || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    const dx = e.clientX - (r.left + r.width / 2)
    const dy = e.clientY - (r.top + r.height / 2)
    mx.set(Math.max(-14, Math.min(14, dx * strength)))
    my.set(Math.max(-10, Math.min(10, dy * strength)))
  }

  function reset() {
    mx.set(0)
    my.set(0)
  }

  const base =
    'relative inline-flex items-center gap-2.5 rounded-[3px] px-5 py-3 text-[13px] font-medium tracking-[-0.01em] transition-colors duration-300'

  const styles = {
    primary:
      'focus-inverse bg-[var(--color-signal)] text-[#04140c] hover:bg-[#55ee9c] shadow-[0_0_0_1px_rgba(63,224,139,0.5),0_10px_36px_-14px_rgba(63,224,139,0.75)]',
    ghost:
      'text-[var(--color-fg)] border border-[var(--color-line-2)] hover:border-[var(--color-fg-dim)] hover:bg-[var(--color-ink-800)]',
  }

  return (
    <motion.a
      ref={ref}
      href={href}
      onMouseMove={onMove}
      onMouseLeave={reset}
      style={{ x, y }}
      whileTap={reduce ? undefined : { scale: 0.965 }}
      transition={SPRING.press}
      className={`${base} ${styles[variant]} ${className}`}
      {...rest}
    >
      {children}
    </motion.a>
  )
}
