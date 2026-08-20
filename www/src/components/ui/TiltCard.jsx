import { useRef } from 'react'
import { motion, useMotionValue, useSpring, useTransform, useReducedMotion } from 'framer-motion'

/**
 * Lift + a small cursor-following tilt. The tilt is capped at ~4deg —
 * enough to register as a physical surface, not enough to become a gimmick.
 */
export default function TiltCard({ children, className = '', max = 4 }) {
  const ref = useRef(null)
  const reduce = useReducedMotion()
  const px = useMotionValue(0)
  const py = useMotionValue(0)

  const cfg = { stiffness: 180, damping: 20, mass: 0.5 }
  const rx = useSpring(useTransform(py, [-0.5, 0.5], [max, -max]), cfg)
  const ry = useSpring(useTransform(px, [-0.5, 0.5], [-max, max]), cfg)
  const lift = useSpring(0, { stiffness: 260, damping: 24 })

  function onMove(e) {
    if (reduce || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    px.set((e.clientX - r.left) / r.width - 0.5)
    py.set((e.clientY - r.top) / r.height - 0.5)
  }

  return (
    <motion.div
      ref={ref}
      onMouseMove={onMove}
      onMouseEnter={() => !reduce && lift.set(-4)}
      onMouseLeave={() => {
        px.set(0)
        py.set(0)
        lift.set(0)
      }}
      style={reduce ? undefined : { rotateX: rx, rotateY: ry, y: lift, transformPerspective: 900 }}
      className={className}
    >
      {children}
    </motion.div>
  )
}
