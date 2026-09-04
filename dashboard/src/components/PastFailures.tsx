import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import ExplainFailure from './ExplainFailure'
import { ErrorNote } from './ui'
import { helpFor } from '../lib/failureReasons'

/**
 * The failures a service has already recovered from.
 *
 * A card describes the latest deployment, which is the right default and a
 * poor memory: the moment something is fixed, the thing that broke it stops
 * being visible anywhere a person is looking. The four registry failures that
 * cost an afternoon were reachable only by opening the service, scrolling its
 * history, and knowing to look — after the service had gone green.
 *
 * Fetched when it is opened rather than with the card. The services list is
 * polled continuously and almost nobody expands this, so putting the rows in
 * that response would be constant work for a rare read. The card is told a
 * count, which is all it needs to decide whether to offer the link at all.
 */

type Deployment = {
  id: string
  status: string
  failureReason: string | null
  startedAt: string
  nodeName: string | null
}

/** The server's rule, so a control never offers what the API would refuse. */
const worthExplaining = (reason: string | null): reason is string =>
  Boolean(reason) && reason!.length > 40 && reason!.includes('\n')

/** First line, trimmed — enough to recognise which failure this was. */
const headline = (reason: string) => {
  const first = reason.split('\n').find((l) => l.trim()) ?? reason
  return first.length > 120 ? first.slice(0, 120) + '…' : first
}

const when = (iso: string) => {
  const d = new Date(iso)
  const mins = Math.round((Date.now() - d.getTime()) / 60_000)
  if (mins < 60) return `${mins}m ago`
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function PastFailures({
  serviceId,
  fleetId,
  /** Excluded because the card is already showing it above. */
  excludeDeploymentId,
}: {
  serviceId: string
  fleetId: string
  excludeDeploymentId?: string
}) {
  const [rows, setRows] = useState<Deployment[] | null>(null)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    let live = true
    api<{ deployments: Deployment[] }>(`/services/${serviceId}/deployments`)
      .then((r) => {
        if (live) setRows(r.deployments)
      })
      .catch((e) => {
        if (live) setError(e)
      })
    // Cancelled on unmount so collapsing the panel mid-request does not set
    // state on a component that is gone.
    return () => {
      live = false
    }
  }, [serviceId])

  if (error) return <ErrorNote error={error} />
  if (!rows) {
    return (
      <p className="font-mono text-[10.5px] text-[var(--color-fg-dim)]">reading the history…</p>
    )
  }

  // Newest first, and only a few. This is a reminder of what went wrong
  // recently, not an audit log — the service page has the full history.
  const failures = rows
    .filter((d) => d.status === 'failed' && d.failureReason && d.id !== excludeDeploymentId)
    .slice(0, 3)

  if (!failures.length) {
    return (
      <p className="font-mono text-[10.5px] text-[var(--color-fg-dim)]">
        nothing recent worth showing
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {failures.map((d) => (
        <div key={d.id} className="rounded-[3px] border border-[var(--color-line)] p-3">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-down)]">
              failed
            </span>
            <span className="font-mono text-[10px] text-[var(--color-fg-dim)]">
              {when(d.startedAt)}
              {d.nodeName ? ` · ${d.nodeName}` : ''}
            </span>
          </div>
          <p className="mt-1.5 break-all font-mono text-[10.5px] leading-relaxed text-[var(--color-fg-muted)]">
            {headline(d.failureReason!)}
          </p>
          {helpFor(d.failureReason) && (
            <p className="mt-1.5 font-mono text-[10.5px] leading-relaxed text-[var(--color-fg-dim)]">
              {helpFor(d.failureReason)!.what}
            </p>
          )}
          {worthExplaining(d.failureReason) && (
            <div className="mt-2.5">
              <ExplainFailure
                fleetId={fleetId}
                deploymentId={d.id}
                failureReason={d.failureReason}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
