import { motion, useReducedMotion } from 'framer-motion'
import { EASE } from '../../lib/motion'

/**
 * Scroll reveal. Fires once per element. Under prefers-reduced-motion the
 * translate and the stagger are dropped and only opacity survives.
 */
export default function Reveal({
  children,
  i = 0,
  y = 20,
  duration = 0.72,
  ease = EASE.expo,
  className = '',
  as = 'div',
  amount = 0.35,
  ...rest
}) {
  const reduce = useReducedMotion()
  const M = motion[as] ?? motion.div

  return (
    <M
      className={className}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y }}
      whileInView={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
      viewport={{ once: true, amount }}
      transition={
        reduce
          ? { duration: 0.3 }
          : { duration, delay: i * 0.075, ease }
      }
      {...rest}
    >
      {children}
    </M>
  )
}
