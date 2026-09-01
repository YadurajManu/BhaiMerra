import { useMemo, useState } from 'react'
import { api, type TimelineEvent } from '../lib/api'
import { useAuth, usePoll } from '../lib/auth'
import { since } from '../lib/format'
import { Empty, ErrorNote, Panel } from '../components/ui'

const REASON_TONE: Record<string, string> = {
  failover: 'text-[var(--color-warn)]',
  reclaim: 'text-[var(--color-signal)]',
  drain: 'text-[var(--color-warn)]',
  manual: 'text-[var(--color-fg-dim)]',
  initial: 'text-[var(--color-fg-dim)]',
  redeploy: 'text-[var(--color-fg-dim)]',
}

export default function Events() {
  const { fleet } = useAuth()
  const { data, error, loading } = usePoll(
    () => api<{ events: TimelineEvent[] }>(`/fleets/${fleet?.id}/events?limit=100`),
    [fleet?.id],
    6000
  )

  // This is the audit trail, and there was no way to search it. Working out
  // who stopped four services meant reading the control plane's container
  // logs, because the page that exists to answer that could not.
  const [query, setQuery] = useState('')
  const [reason, setReason] = useState<string>('all')

  const events = data?.events ?? []

  const reasons = useMemo(
    () => ['all', ...[...new Set(events.map((e) => e.reason))].sort()],
    [events]
  )

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return events.filter((e) => {
      if (reason !== 'all' && e.reason !== reason) return false
      if (!q) return true
      return (
        e.service.toLowerCase().includes(q) ||
        e.reason.toLowerCase().includes(q) ||
        (e.to ?? '').toLowerCase().includes(q) ||
        (e.from ?? '').toLowerCase().includes(q)
      )
    })
  }, [events, query, reason])

  if (error) return <ErrorNote error={error} />

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[22px] font-semibold tracking-[-0.03em]">Events</h1>
        <p className="mt-1 text-[13.5px] text-[var(--color-fg-muted)]">
          Every placement decision, in order. A failover records why the winning node won.
        </p>
      </div>

      {events.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex items-center">
            <span className="pointer-events-none absolute left-2.5 text-[11px] text-[var(--color-fg-dim)]">🔍</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search service or node…"
              className="h-[30px] w-[220px] rounded-[3px] border border-[var(--color-line)] bg-[var(--color-ink-900)] pl-7 pr-3 font-mono text-[11.5px] outline-none transition-colors focus:border-[var(--color-line-2)]"
            />
          </div>
          {/* Built from the reasons present, not a hardcoded list — a filter
              offering options that match nothing teaches you to ignore it. */}
          <div className="flex flex-wrap items-center gap-1">
            {reasons.map((r) => (
              <button
                key={r}
                onClick={() => setReason(r)}
                className={`press rounded-[3px] px-2.5 py-1 font-mono text-[11px] ${
                  reason === r
                    ? 'bg-[var(--color-ink-800)] text-[var(--color-fg)]'
                    : 'text-[var(--color-fg-dim)] hover:text-[var(--color-fg-muted)]'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
          <span className="ml-auto font-mono text-[10.5px] text-[var(--color-fg-dim)]">
            {shown.length} of {events.length}
          </span>
        </div>
      )}

      {!loading && !events.length ? (
        <Empty title="Nothing has happened yet" hint="Deploys, failovers and reclaims all land here." />
      ) : !shown.length ? (
        <Empty
          title="No events match"
          hint="Nothing here matches that search and filter. Clear them to see the full timeline."
        />
      ) : (
        <Panel>
          <div className="divide-y divide-[var(--color-line)]">
            {shown.map((e, i) => {
              const score = typeof e.detail?.score === 'number' ? (e.detail.score as number) : null
              return (
                <div key={`${e.at}-${i}`} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-5 py-3">
                  <span className="min-w-[92px] font-mono text-[11px] text-[var(--color-fg-dim)]">{since(e.at)}</span>
                  <span className="min-w-[130px] font-mono text-[12.5px]">{e.service}</span>
                  <span
                    className={`min-w-[80px] font-mono text-[10px] uppercase tracking-[0.1em] ${
                      REASON_TONE[e.reason] ?? 'text-[var(--color-fg-dim)]'
                    }`}
                  >
                    {e.reason}
                  </span>
                  <span className="font-mono text-[11.5px] text-[var(--color-fg-muted)]">
                    {e.from ? `${e.from} → ${e.to}` : `→ ${e.to}`}
                  </span>
                  {score !== null && (
                    <span className="tabular ml-auto font-mono text-[10.5px] text-[var(--color-fg-dim)]">
                      score {score.toFixed(3)}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </Panel>
      )}
    </div>
  )
}
