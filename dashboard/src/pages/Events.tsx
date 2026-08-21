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

  if (error) return <ErrorNote error={error} />
  const events = data?.events ?? []

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[22px] font-semibold tracking-[-0.03em]">Events</h1>
        <p className="mt-1 text-[13.5px] text-[var(--color-fg-muted)]">
          Every placement decision, in order. A failover records why the winning node won.
        </p>
      </div>

      {!loading && !events.length ? (
        <Empty title="Nothing has happened yet" hint="Deploys, failovers and reclaims all land here." />
      ) : (
        <Panel>
          <div className="divide-y divide-[var(--color-line)]">
            {events.map((e, i) => {
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
