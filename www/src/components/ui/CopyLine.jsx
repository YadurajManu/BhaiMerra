import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { EASE } from '../../lib/motion'

export default function CopyLine({ command, className = '' }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard blocked — the command is on screen anyway */
    }
  }

  return (
    <button
      onClick={copy}
      className={`group flex w-full items-center gap-3 rounded-[3px] border border-[var(--color-line)] bg-[var(--color-ink-900)] px-3.5 py-2.5 text-left transition-colors duration-300 hover:border-[var(--color-line-2)] ${className}`}
    >
      <span className="select-none font-mono text-[12px] text-[var(--color-signal)]">$</span>
      <code className="no-scrollbar min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[11.5px] sm:text-[12px] text-[var(--color-fg-muted)] transition-colors duration-300 group-hover:text-[var(--color-fg)]">
        {command}
      </code>
      <span className="relative h-4 w-11 shrink-0 overflow-hidden">
        <AnimatePresence initial={false} mode="wait">
          <motion.span
            key={copied ? 'y' : 'n'}
            initial={{ y: 10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -10, opacity: 0 }}
            transition={{ duration: 0.28, ease: EASE.expo }}
            className={`absolute inset-0 text-right font-mono text-[10px] leading-4 ${
              copied ? 'text-[var(--color-signal)]' : 'text-[var(--color-fg-dim)]'
            }`}
          >
            {copied ? 'copied' : 'copy'}
          </motion.span>
        </AnimatePresence>
      </span>
    </button>
  )
}
