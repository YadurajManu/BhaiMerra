import { useState, useEffect, useRef, useMemo } from 'react'
import { Dot } from './ui'

export interface LogTerminalProps {
  serviceName?: string
  nodeName?: string
  lines?: string[]
  diagnostic?: string | null
  loading?: boolean
  isLive?: boolean
  onToggleLive?: () => void
  onRefresh?: () => void
  className?: string
  height?: string
}

type LogLevel = 'ALL' | 'ERROR' | 'WARN' | 'INFO'

interface ParsedLine {
  raw: string
  level: 'error' | 'warn' | 'info' | 'plain'
  timestamp?: string
  message: string
}

export default function LogTerminal({
  serviceName = 'service',
  nodeName,
  lines = [],
  diagnostic = null,
  loading = false,
  isLive = true,
  onToggleLive,
  onRefresh,
  className = '',
  height = '520px',
}: LogTerminalProps) {
  const [search, setSearch] = useState('')
  const [useRegex, setUseRegex] = useState(false)
  const [activeLevel, setActiveLevel] = useState<LogLevel>('ALL')
  const [autoScroll, setAutoScroll] = useState(true)
  const [showLineNumbers, setShowLineNumbers] = useState(true)
  const [showTimestamps, setShowTimestamps] = useState(true)
  const [wrapLines, setWrapLines] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [copied, setCopied] = useState(false)

  /** Lines that arrived while scrolled back, so the pill can say how many. */
  const [pendingLines, setPendingLines] = useState(0)

  const containerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const lastCountRef = useRef(0)

  // Parse lines to detect log levels and timestamps
  const parsedLines = useMemo<ParsedLine[]>(() => {
    return lines.map((line) => {
      let level: 'error' | 'warn' | 'info' | 'plain' = 'plain'
      const lower = line.toLowerCase()

      // Severity is matched on whole words and on status codes in the places
      // a status code actually appears.
      //
      // Substring matching tinted half the screen red: `"error": null` is a
      // successful response, `includes('500')` matches a byte count, a port,
      // or a timestamp, and `includes('200')` matched the year in every
      // timestamp of the form 2026-.... The result was a log where the colour
      // carried no information, which is worse than no colour at all.
      const hasWord = (re: RegExp) => re.test(lower)
      // "level":"error", level=error, [ERROR], ERROR:, or the bare word.
      const ERROR_WORDS = /\b(error|fatal|panic|exception|failed|failure)\b/
      const WARN_WORDS = /\b(warn|warning|deprecated)\b/
      const INFO_WORDS = /\b(info|started|connected|ready|listening)\b/
      // A status code, only where one is plausibly being reported: after a
      // method and path, or after "status"/"code".
      const statusCode = lower.match(/\b(?:status|code)[":= ]+(\d{3})\b/)?.[1]
        ?? lower.match(/"\s*(?:get|post|put|patch|delete|head|options)\s[^"]*"\s+(\d{3})\b/)?.[1]

      if (ERROR_WORDS.test(lower) || (statusCode && statusCode.startsWith('5'))) {
        level = 'error'
      } else if (hasWord(WARN_WORDS) || (statusCode && statusCode.startsWith('4'))) {
        level = 'warn'
      } else if (hasWord(INFO_WORDS) || (statusCode && statusCode.startsWith('2'))) {
        level = 'info'
      }

      // Try matching ISO timestamp like 2026-08-28T12:34:56Z or 2026/08/28 12:34:56
      const tsMatch = line.match(/^(\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s*(.*)$/)
      if (tsMatch) {
        return {
          raw: line,
          level,
          timestamp: tsMatch[1],
          message: tsMatch[2] ?? '',
        }
      }

      return {
        raw: line,
        level,
        message: line,
      }
    })
  }, [lines])

  // Count by level for badges
  const counts = useMemo(() => {
    let error = 0
    let warn = 0
    let info = 0
    for (const l of parsedLines) {
      if (l.level === 'error') error++
      else if (l.level === 'warn') warn++
      else if (l.level === 'info') info++
    }
    return { all: parsedLines.length, error, warn, info }
  }, [parsedLines])

  // Filter lines by level and search query
  const filteredLines = useMemo(() => {
    return parsedLines.filter((l) => {
      if (activeLevel === 'ERROR' && l.level !== 'error') return false
      if (activeLevel === 'WARN' && l.level !== 'warn' && l.level !== 'error') return false
      if (activeLevel === 'INFO' && l.level !== 'info' && l.level !== 'plain') return false

      if (!search.trim()) return true

      if (useRegex) {
        try {
          const re = new RegExp(search, 'i')
          return re.test(l.raw)
        } catch {
          return l.raw.toLowerCase().includes(search.toLowerCase())
        }
      }
      return l.raw.toLowerCase().includes(search.toLowerCase())
    })
  }, [parsedLines, activeLevel, search, useRegex])

  // Follow the tail, or count what is being missed while scrolled back.
  //
  // `isUserScrollingRef` was declared, read here, and never assigned, so the
  // guard it looked like it provided did nothing at all.
  useEffect(() => {
    const arrived = filteredLines.length - lastCountRef.current
    lastCountRef.current = filteredLines.length
    if (autoScroll) {
      setPendingLines(0)
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    } else if (arrived > 0) {
      setPendingLines((n) => n + arrived)
    }
  }, [filteredLines, autoScroll])

  // Scrolling back pauses the follow; scrolling to the bottom resumes it.
  // Only the first half existed, so once you looked at anything you had to
  // find the button to start following again.
  const handleScroll = () => {
    if (!containerRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 40
    if (!isAtBottom && autoScroll) setAutoScroll(false)
    if (isAtBottom && !autoScroll) {
      setAutoScroll(true)
      setPendingLines(0)
    }
  }

  // Copy all visible lines
  const copyAll = async () => {
    const text = filteredLines.map((l) => l.raw).join('\n')
    await navigator.clipboard?.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // Download log file
  const downloadLogs = () => {
    const text = filteredLines.map((l) => l.raw).join('\n')
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${serviceName}-logs-${new Date().toISOString().slice(0, 19)}.log`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // Highlight matches in text
  const renderHighlightedMessage = (text: string) => {
    if (!search.trim()) return text

    try {
      const parts: Array<{ text: string; match: boolean }> = []
      let lastIdx = 0
      const regex = new RegExp(useRegex ? search : search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
      let m: RegExpExecArray | null

      while ((m = regex.exec(text)) !== null) {
        if (m.index > lastIdx) {
          parts.push({ text: text.slice(lastIdx, m.index), match: false })
        }
        parts.push({ text: m[0], match: true })
        lastIdx = m.index + m[0].length
        if (!regex.global) break
      }
      if (lastIdx < text.length) {
        parts.push({ text: text.slice(lastIdx), match: false })
      }

      return (
        <>
          {parts.map((p, i) =>
            p.match ? (
              <mark key={i} className="rounded-xs bg-[#ffb547]/30 px-0.5 text-[#ffc875] font-semibold">
                {p.text}
              </mark>
            ) : (
              p.text
            )
          )}
        </>
      )
    } catch {
      return text
    }
  }

  // Keyboard shortcut: Escape to exit fullscreen
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isFullscreen) {
        setIsFullscreen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isFullscreen])

  return (
    <div
      className={`panel flex flex-col border border-[var(--color-line)] bg-[var(--color-ink-950)] text-[var(--color-fg)] transition-all ${
        isFullscreen
          ? 'fixed inset-0 z-50 h-screen w-screen rounded-none border-none p-0'
          : `rounded-[4px] ${className}`
      }`}
      style={{ height: isFullscreen ? '100vh' : height }}
    >
      {/* ── Top Bar / Header ───────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-line)] bg-[var(--color-ink-900)] px-4 py-2.5">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="flex h-2 w-2 relative">
              {isLive && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-signal)] opacity-75" />
              )}
              <span
                className={`relative inline-flex h-2 w-2 rounded-full ${
                  isLive ? 'bg-[var(--color-signal)]' : 'bg-[var(--color-fg-dim)]'
                }`}
              />
            </span>
            <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-fg)]">
              {isLive ? 'Live Stream' : 'Paused'}
            </span>
          </div>

          {nodeName && (
            <span className="hidden items-center gap-1.5 rounded-[3px] border border-[var(--color-line)] bg-[var(--color-ink-850)] px-2 py-0.5 font-mono text-[10.5px] text-[var(--color-fg-muted)] sm:inline-flex">
              <span className="text-[var(--color-fg-dim)]">host:</span>
              <span className="font-medium text-[var(--color-fg)]">{nodeName}</span>
            </span>
          )}

          {loading && (
            <span className="font-mono text-[10px] text-[var(--color-signal)] animate-pulse">
              syncing…
            </span>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1.5">
          {onToggleLive && (
            <button
              onClick={onToggleLive}
              title={isLive ? 'Pause auto-refresh' : 'Resume live stream'}
              className={`inline-flex items-center gap-1.5 rounded-[3px] border px-2.5 py-1 font-mono text-[11px] transition-colors ${
                isLive
                  ? 'border-[var(--color-line-2)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
                  : 'border-[var(--color-signal-dim)] bg-[color-mix(in_oklab,var(--color-signal)_10%,transparent)] text-[var(--color-signal)]'
              }`}
            >
              {isLive ? '⏸ Pause' : '▶ Resume'}
            </button>
          )}

          <button
            onClick={copyAll}
            title="Copy logs to clipboard"
            className="inline-flex items-center gap-1 rounded-[3px] border border-[var(--color-line-2)] px-2.5 py-1 font-mono text-[11px] text-[var(--color-fg-muted)] transition-colors hover:border-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
          >
            {copied ? '✓ Copied!' : '📋 Copy'}
          </button>

          <button
            onClick={downloadLogs}
            title="Download log file"
            className="hidden items-center gap-1 rounded-[3px] border border-[var(--color-line-2)] px-2.5 py-1 font-mono text-[11px] text-[var(--color-fg-muted)] transition-colors hover:border-[var(--color-fg-dim)] hover:text-[var(--color-fg)] sm:inline-flex"
          >
            💾 Export
          </button>

          <button
            onClick={() => setIsFullscreen(!isFullscreen)}
            title={isFullscreen ? 'Exit Fullscreen (Esc)' : 'Expand to Fullscreen'}
            className="inline-flex items-center justify-center rounded-[3px] border border-[var(--color-line-2)] p-1 px-2 font-mono text-[11px] text-[var(--color-fg-muted)] transition-colors hover:border-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
          >
            {isFullscreen ? '↙ Standard' : '⛶ Fullscreen'}
          </button>
        </div>
      </div>

      {/* ── Filter & Search Toolbar ────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-[var(--color-line)] bg-[var(--color-ink-950)] px-4 py-2">
        {/* Level Filters */}
        <div className="flex items-center gap-1 font-mono text-[11px]">
          {(
            [
              ['ALL', `All (${counts.all})`, 'text-[var(--color-fg)]'],
              ['ERROR', `Error (${counts.error})`, 'text-[var(--color-down)]'],
              ['WARN', `Warn (${counts.warn})`, 'text-[var(--color-warn)]'],
              ['INFO', `Info (${counts.info})`, 'text-[var(--color-signal)]'],
            ] as const
          ).map(([lvl, label, colorCls]) => (
            <button
              key={lvl}
              onClick={() => setActiveLevel(lvl)}
              className={`rounded-[3px] px-2 py-0.5 transition-colors ${
                activeLevel === lvl
                  ? 'bg-[var(--color-ink-800)] font-medium ' + colorCls
                  : 'text-[var(--color-fg-dim)] hover:text-[var(--color-fg-muted)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Search & Options */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Search Box */}
          <div className="relative flex items-center">
            <span className="pointer-events-none absolute left-2.5 text-[11px] text-[var(--color-fg-dim)]">🔍</span>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter logs / regex…"
              className="h-[28px] w-[180px] rounded-[3px] border border-[var(--color-line)] bg-[var(--color-ink-900)] pl-7 pr-7 font-mono text-[11.5px] text-[var(--color-fg)] outline-none transition-all placeholder:text-[var(--color-fg-dim)] focus:w-[240px] focus:border-[var(--color-line-2)]"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-2 text-[10px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
              >
                ✕
              </button>
            )}
          </div>

          <button
            onClick={() => setUseRegex(!useRegex)}
            title="Toggle regular expressions"
            className={`h-[28px] rounded-[3px] border px-2 font-mono text-[10.5px] transition-colors ${
              useRegex
                ? 'border-[var(--color-signal)] bg-[var(--color-signal)]/10 text-[var(--color-signal)]'
                : 'border-[var(--color-line)] text-[var(--color-fg-dim)] hover:border-[var(--color-line-2)]'
            }`}
          >
            .*
          </button>

          {/* Toggle Switches */}
          <button
            onClick={() => setWrapLines(!wrapLines)}
            title="Toggle line wrapping"
            className={`h-[28px] rounded-[3px] border px-2 font-mono text-[10.5px] transition-colors ${
              wrapLines
                ? 'border-[var(--color-signal-dim)] text-[var(--color-fg)]'
                : 'border-[var(--color-line)] text-[var(--color-fg-dim)] hover:border-[var(--color-line-2)]'
            }`}
          >
            Wrap
          </button>

          {/* `showLineNumbers` had a setter that nothing called: the state
              existed, the column honoured it, and there was no way to reach
              it. Either give it a control or delete it. */}
          <button
            onClick={() => setShowLineNumbers(!showLineNumbers)}
            title="Toggle line numbers"
            className={`h-[28px] rounded-[3px] border px-2 font-mono text-[10.5px] transition-colors ${
              showLineNumbers
                ? 'border-[var(--color-signal-dim)] text-[var(--color-fg)]'
                : 'border-[var(--color-line)] text-[var(--color-fg-dim)] hover:border-[var(--color-line-2)]'
            }`}
          >
            №
          </button>

          <button
            onClick={() => setShowTimestamps(!showTimestamps)}
            title="Toggle timestamp column"
            className={`h-[28px] rounded-[3px] border px-2 font-mono text-[10.5px] transition-colors ${
              showTimestamps
                ? 'border-[var(--color-signal-dim)] text-[var(--color-fg)]'
                : 'border-[var(--color-line)] text-[var(--color-fg-dim)] hover:border-[var(--color-line-2)]'
            }`}
          >
            Time
          </button>

          <button
            onClick={() => setAutoScroll(!autoScroll)}
            title={autoScroll ? 'Auto-scroll is ON' : 'Auto-scroll is OFF'}
            className={`h-[28px] inline-flex items-center gap-1.5 rounded-[3px] border px-2 font-mono text-[10.5px] transition-colors ${
              autoScroll
                ? 'border-[var(--color-signal)] bg-[color-mix(in_oklab,var(--color-signal)_10%,transparent)] text-[var(--color-signal)]'
                : 'border-[var(--color-line)] text-[var(--color-fg-dim)] hover:border-[var(--color-line-2)]'
            }`}
          >
            <span>Auto-scroll</span>
            <span className={`h-1.5 w-1.5 rounded-full ${autoScroll ? 'bg-[var(--color-signal)]' : 'bg-[var(--color-fg-dim)]'}`} />
          </button>
        </div>
      </div>

      {/* ── Main Terminal Body ─────────────────────────────────── */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="relative flex-1 overflow-auto bg-[#07080a] p-3 font-mono text-[11.5px] leading-[1.6] select-text"
      >
        {filteredLines.length > 0 ? (
          <div className="space-y-0.5">
            {filteredLines.map((line, idx) => {
              const levelColor =
                line.level === 'error'
                  ? 'text-[#ff786e] bg-[color-mix(in_oklab,var(--color-down)_8%,transparent)]'
                  : line.level === 'warn'
                  ? 'text-[#ffc061] bg-[color-mix(in_oklab,var(--color-warn)_6%,transparent)]'
                  : line.level === 'info'
                  ? 'text-[#d6deeb]'
                  : 'text-[#9eaab7]'

              return (
                <div
                  key={idx}
                  className={`group flex items-start gap-2.5 rounded-[2px] px-1.5 py-0.5 transition-colors hover:bg-[rgba(255,255,255,0.03)] ${
                    wrapLines ? 'break-words' : 'whitespace-pre'
                  } ${line.level === 'error' || line.level === 'warn' ? levelColor : ''}`}
                >
                  {/* Line Number */}
                  {showLineNumbers && (
                    <span className="w-[38px] shrink-0 select-none text-right font-mono text-[10px] text-[#424953] group-hover:text-[#6a7582]">
                      {idx + 1}
                    </span>
                  )}

                  {/* Level Indicator Pill */}
                  <span
                    className={`w-[14px] shrink-0 select-none text-center font-mono text-[10px] ${
                      line.level === 'error'
                        ? 'font-bold text-[var(--color-down)]'
                        : line.level === 'warn'
                        ? 'font-bold text-[var(--color-warn)]'
                        : line.level === 'info'
                        ? 'text-[var(--color-signal-dim)]'
                        : 'text-transparent'
                    }`}
                  >
                    {line.level === 'error' ? '✖' : line.level === 'warn' ? '▲' : line.level === 'info' ? '●' : '·'}
                  </span>

                  {/* Timestamp */}
                  {showTimestamps && line.timestamp && (
                    <span className="shrink-0 select-none font-mono text-[10.5px] text-[#55616f]">
                      {line.timestamp}
                    </span>
                  )}

                  {/* Log Content */}
                  <span className={`flex-1 font-mono ${levelColor}`}>
                    {renderHighlightedMessage(line.message)}
                  </span>
                </div>
              )
            })}
            <div ref={bottomRef} className="h-4" />
          </div>
        ) : (
          <div className="flex h-full min-h-[260px] flex-col items-center justify-center gap-3 text-center">
            {diagnostic ? (
              <div className="max-w-md rounded-[4px] border border-[var(--color-line)] bg-[var(--color-ink-900)] p-5 text-left">
                <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-warn)]">
                  Diagnostic State
                </div>
                <p className="mt-2 text-[12.5px] text-[var(--color-fg-muted)] leading-relaxed">{diagnostic}</p>
              </div>
            ) : search ? (
              <div className="text-[var(--color-fg-dim)]">
                <p className="text-[13px] text-[var(--color-fg-muted)]">No logs match query "{search}"</p>
                <button
                  onClick={() => setSearch('')}
                  className="mt-2 text-[11px] text-[var(--color-signal)] underline hover:text-[#55ee9c]"
                >
                  Clear search filter
                </button>
              </div>
            ) : (
              <div className="text-[var(--color-fg-dim)]">
                <span className="font-mono text-[16px]">▤</span>
                <p className="mt-2 text-[12.5px] text-[var(--color-fg-muted)]">
                  Waiting for container output from <span className="font-mono text-[var(--color-fg)]">{serviceName}</span>…
                </p>
                <p className="mt-1 text-[11px] text-[var(--color-fg-dim)]">
                  Output will stream here automatically when requests land or the container writes to stdout/stderr.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Scrolled back, and lines still arriving.
            `fixed` pinned this to the viewport's corner rather than the
            terminal's, so on any page where the terminal was not the last
            thing on screen the button appeared somewhere unrelated to it. */}
        {!autoScroll && filteredLines.length > 0 && (
          <button
            onClick={() => {
              setAutoScroll(true)
              setPendingLines(0)
              bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
            }}
            className="press sticky bottom-2 left-full z-30 mr-2 inline-flex items-center gap-1.5 rounded-[3px] border border-[var(--color-signal-dim)] bg-[var(--color-ink-900)] px-3 py-1.5 font-mono text-[11px] text-[var(--color-signal)] shadow-lg hover:bg-[var(--color-ink-850)]"
          >
            <span>
              {pendingLines > 0
                ? `↓ ${pendingLines} new line${pendingLines === 1 ? '' : 's'}`
                : '↓ Jump to latest'}
            </span>
            {pendingLines > 0 && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-signal)]" />}
          </button>
        )}
      </div>

      {/* ── Bottom Status Bar ──────────────────────────────────── */}
      <div className="flex items-center justify-between border-t border-[var(--color-line)] bg-[var(--color-ink-900)] px-4 py-1.5 font-mono text-[10.5px] text-[var(--color-fg-dim)]">
        <div className="flex items-center gap-4">
          <span>
            Showing <strong className="text-[var(--color-fg-muted)]">{filteredLines.length}</strong> of{' '}
            <strong className="text-[var(--color-fg-muted)]">{lines.length}</strong> lines
          </span>
          {search && (
            <span className="text-[var(--color-warn)]">
              Filtered by: "{search}"
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span>UTF-8</span>
          <span>·</span>
          <span>Stream: 2.0s</span>
        </div>
      </div>
    </div>
  )
}
