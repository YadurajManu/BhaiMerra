import Reveal from './Reveal'

export default function SectionHead({ index, kicker, title, lede, align = 'left', max = 'max-w-2xl' }) {
  return (
    <div className={align === 'right' ? 'ml-auto text-right' : ''}>
      <Reveal className="flex items-center gap-3" y={10} duration={0.5}>
        {index && (
          <span className="font-mono text-[11px] text-[var(--color-signal)]">{index}</span>
        )}
        <span className="mono-label">{kicker}</span>
        <span className="h-px flex-1 bg-[var(--color-line)] min-w-8" />
      </Reveal>
      <Reveal i={1}>
        <h2 className={`mt-5 text-[clamp(1.9rem,4.2vw,3.1rem)] font-semibold leading-[1.03] tracking-[-0.035em] text-balance ${max}`}>
          {title}
        </h2>
      </Reveal>
      {lede && (
        <Reveal i={2}>
          <p className={`mt-5 text-[15px] leading-relaxed text-[var(--color-fg-muted)] text-pretty ${max}`}>
            {lede}
          </p>
        </Reveal>
      )}
    </div>
  )
}
