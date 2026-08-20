import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { EASE } from '../lib/motion'
import StatusDot from './ui/StatusDot'

function Meter({ label, value, max, unit, tone = 'signal' }) {
  const pct = Math.min(1, value / max)
  return (
    <div className="flex items-center gap-3">
      <span className="w-7 shrink-0 font-mono text-[9.5px] uppercase tracking-[0.1em] text-[var(--color-fg-dim)]">
        {label}
      </span>
      <span className="relative h-[3px] flex-1 bg-[var(--color-line)]">
        <motion.span
          className="absolute inset-y-0 left-0"
          style={{ background: `var(--color-${tone})` }}
          animate={{ width: `${pct * 100}%` }}
          transition={{ duration: 0.9, ease: EASE.glide }}
        />
      </span>
      <span className="w-[70px] shrink-0 text-right font-mono text-[9.5px] text-[var(--color-fg-muted)]">
        {unit}
      </span>
    </div>
  )
}

/**
 * The live readout for the pulsing node in the graph. Values drift the way a
 * real idle homelab box does — this is the product's own telemetry, not decor.
 */
export default function NodeHUD({ className = '' }) {
  const reduce = useReducedMotion()
  const [cpu, setCpu] = useState(0.31)
  const [ram, setRam] = useState(4.1)
  const [beat, setBeat] = useState(1.2)

  useEffect(() => {
    if (reduce) return
    const id = setInterval(() => {
      setCpu((v) => Math.min(0.62, Math.max(0.18, v + (Math.random() - 0.5) * 0.08)))
      setRam((v) => Math.min(6.4, Math.max(3.4, v + (Math.random() - 0.5) * 0.25)))
      setBeat(Number((0.4 + Math.random() * 2.2).toFixed(1)))
    }, 1800)
    return () => clearInterval(id)
  }, [reduce])

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.9, delay: 0.95, ease: EASE.expo }}
      className={`w-[300px] border border-[var(--color-line)] bg-[color-mix(in_oklab,var(--color-ink-900)_88%,transparent)] backdrop-blur-[2px] ${className}`}
    >
      <div className="flex items-center justify-between border-b border-[var(--color-line)] px-3.5 py-2">
        <span className="font-mono text-[10.5px] text-[var(--color-fg)]">node-01</span>
        <span className="flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[var(--color-signal)]">
          <StatusDot size={5} /> online
        </span>
      </div>

      <div className="space-y-2.5 px-3.5 py-3">
        <div className="font-mono text-[9.5px] tracking-[0.08em] text-[var(--color-fg-dim)]">
          home-server · amd64 · 4 cores
        </div>
        <Meter label="cpu" value={cpu} max={1} unit={`${Math.round(cpu * 100)}%`} />
        <Meter label="ram" value={ram} max={8} unit={`${ram.toFixed(1)} / 8 GB`} />

        <div className="flex flex-wrap gap-1.5 pt-1">
          {['web', 'cache', 'img-proxy'].map((s) => (
            <span
              key={s}
              className="border border-[var(--color-line-2)] px-1.5 py-[3px] font-mono text-[9px] text-[var(--color-fg-muted)]"
            >
              {s}
            </span>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-[var(--color-line)] px-3.5 py-2 font-mono text-[9.5px] text-[var(--color-fg-dim)]">
        <span>last heartbeat</span>
        <span className="text-[var(--color-fg-muted)]">{beat.toFixed(1)}s ago</span>
      </div>
    </motion.div>
  )
}
