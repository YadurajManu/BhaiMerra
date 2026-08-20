import { motion, useReducedMotion } from 'framer-motion'
import { EASE } from '../../lib/motion'

// The mark is the product: six peers, one of them live, wired into a mesh.
const MARK_NODES = [
  { x: 9, y: 9, r: 3.1, live: true },
  { x: 26, y: 6, r: 2, live: false },
  { x: 33, y: 19, r: 2.4, live: false },
  { x: 20, y: 17.5, r: 1.6, live: false },
  { x: 24, y: 31, r: 2.2, live: false },
  { x: 8, y: 26, r: 1.9, live: false },
]
const MARK_EDGES = [
  [0, 3], [3, 1], [3, 2], [0, 5], [5, 4], [4, 2], [1, 2], [0, 1],
]

/**
 * @param size    px width of the mark
 * @param word    render the wordmark alongside
 * @param animate draw the edges in and keep the live node breathing
 */
export default function Logo({ size = 20, word = false, animate = false, tagline = false, className = '' }) {
  const reduce = useReducedMotion()
  const play = animate && !reduce

  return (
    <span className={`inline-flex items-center gap-3 ${className}`}>
      <motion.svg
        width={size}
        height={size}
        viewBox="0 0 40 40"
        fill="none"
        aria-hidden="true"
        // Draws itself on mount rather than on scroll — the mark is often
        // already on screen (nav, menu), where a viewport trigger never fires.
        initial={play ? 'rest' : false}
        animate={play ? 'live' : undefined}
        whileHover={play ? 'live' : undefined}
        className="shrink-0 overflow-visible"
      >
        {MARK_EDGES.map(([a, b], i) => (
          <motion.line
            key={i}
            x1={MARK_NODES[a].x}
            y1={MARK_NODES[a].y}
            x2={MARK_NODES[b].x}
            y2={MARK_NODES[b].y}
            stroke="#4a5763"
            strokeWidth="1.05"
            variants={{
              rest: { pathLength: 0, opacity: 0 },
              live: {
                pathLength: 1,
                opacity: 1,
                transition: { duration: 0.5, delay: 0.08 + i * 0.055, ease: EASE.expo },
              },
            }}
          />
        ))}

        {MARK_NODES.map((n, i) => (
          <motion.circle
            key={i}
            cx={n.x}
            cy={n.y}
            r={n.r}
            fill={n.live ? 'var(--color-signal)' : '#8d99a6'}
            style={{ transformOrigin: `${n.x}px ${n.y}px` }}
            variants={{
              rest: { scale: 0, opacity: 0 },
              live: {
                scale: 1,
                opacity: 1,
                transition: { duration: 0.4, delay: i * 0.05, ease: EASE.snap },
              },
            }}
          />
        ))}

        {/* heartbeat ring on the live peer */}
        {play && (
          <motion.circle
            cx={MARK_NODES[0].x}
            cy={MARK_NODES[0].y}
            r={MARK_NODES[0].r}
            fill="none"
            stroke="var(--color-signal)"
            strokeWidth="0.9"
            style={{ transformOrigin: `${MARK_NODES[0].x}px ${MARK_NODES[0].y}px` }}
            animate={{ scale: [1, 3.1], opacity: [0.55, 0] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: 'easeOut' }}
          />
        )}
      </motion.svg>

      {word && (
        <span className="leading-none">
          <span
            className="block font-mono font-medium tracking-[0.01em]"
            style={{ fontSize: size * 0.72 }}
          >
            fleet<span className="text-[var(--color-fg-dim)]">·</span>os
          </span>
          {tagline && (
            <span className="mt-1.5 block font-mono text-[9.5px] uppercase tracking-[0.18em] text-[var(--color-fg-dim)]">
              orchestration for hardware you own
            </span>
          )}
        </span>
      )}
    </span>
  )
}
