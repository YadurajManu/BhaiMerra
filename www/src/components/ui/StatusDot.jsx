const TONE = {
  online: { color: 'var(--color-signal)', anim: 'signal-pulse 2.4s ease-out infinite' },
  warn: { color: 'var(--color-warn)', anim: 'warn-pulse 1.5s ease-out infinite' },
  down: { color: 'var(--color-down)', anim: 'none' },
  idle: { color: 'var(--color-fg-dim)', anim: 'none' },
}

export default function StatusDot({ tone = 'online', size = 7, className = '' }) {
  const t = TONE[tone] ?? TONE.idle
  return (
    <span
      className={`inline-block shrink-0 rounded-full ${className}`}
      style={{
        width: size,
        height: size,
        background: t.color,
        animation: t.anim,
      }}
    />
  )
}
