import { useState } from 'react'
import { api } from '../lib/api'
import { Button, Copyable, ErrorNote } from './ui'

/**
 * A reading of a failed deploy, beside the log it was read from.
 *
 * Deliberately not instead of the log. The raw output stays one click away and
 * is never replaced, because an explanation is an interpretation and the reader
 * has to be able to check it. A summary that quietly stands in for the evidence
 * is worse than no summary, since a wrong one is then unfalsifiable.
 *
 * Nothing here runs on load. It costs money and an allowance, so it happens
 * when somebody asks — and once it exists it is cached against the failure
 * rather than the deployment, which is why a second reader gets it instantly
 * and for free.
 */

type Outcome = {
  status: 'ok' | 'not_worth_it' | 'disabled' | 'rate_limited' | 'failed'
  summary?: string
  steps?: string[]
  cached?: boolean
  hits?: number
  reason?: string
  limit?: number
  resetsInSec?: number
  usage?: { used: number; limit: number }
}

export default function ExplainFailure({
  fleetId,
  deploymentId,
  failureReason,
}: {
  fleetId: string
  deploymentId: string
  failureReason: string
}) {
  const [out, setOut] = useState<Outcome | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [showRaw, setShowRaw] = useState(false)

  const ask = async () => {
    setBusy(true)
    setError(null)
    try {
      setOut(await api<Outcome>(`/fleets/${fleetId}/deployments/${deploymentId}/explain`, { method: 'POST' }))
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border-l-2 border-[var(--color-line-2)] pl-4">
      {!out && (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void ask()} disabled={busy}>
            {busy ? 'Reading the log…' : 'Explain this failure'}
          </Button>
          <span className="font-mono text-[10.5px] text-[var(--color-fg-dim)]">
            reads the last 40 lines · cached answers are free
          </span>
        </div>
      )}

      {busy && !out && (
        // A real wait, so it says what it is doing rather than spinning.
        <p className="shimmer mt-3 font-mono text-[11px] text-[var(--color-fg-dim)]">
          reading the last 40 lines of the build log…
        </p>
      )}

      {error != null && (
        <div className="mt-3">
          <ErrorNote error={error} />
        </div>
      )}

      {out?.status === 'ok' && (
        <div className="fade-up">
          <p className="text-[13.5px] leading-relaxed text-[var(--color-fg)]">{out.summary}</p>

          {!!out.steps?.length && (
            <ol className="mt-3 space-y-2">
              {out.steps.map((step, i) => (
                <li
                  key={i}
                  className="flex items-start gap-3"
                  // Staggered, so the list reads as a sequence rather than
                  // arriving as a block.
                  style={{ animation: `fade-up 0.3s var(--ease-out-expo) ${i * 60}ms both` }}
                >
                  <span className="mt-0.5 font-mono text-[10.5px] text-[var(--color-fg-dim)]">{i + 1}</span>
                  {/^[a-z][\w.-]* /.test(step) && !step.includes(' the ') ? (
                    <Copyable text={step} className="text-[11.5px]" />
                  ) : (
                    <span className="text-[13px] leading-relaxed text-[var(--color-fg-muted)]">{step}</span>
                  )}
                </li>
              ))}
            </ol>
          )}

          {/* Provenance. What it read, how often this failure has been seen,
              and whether this cost anything — so it reads as a tool rather
              than an oracle. */}
          <p className="mt-3 font-mono text-[10px] text-[var(--color-fg-dim)]">
            {out.cached ? 'cached' : 'explained'} from the last 40 lines
            {(out.hits ?? 1) > 1 && ` · seen ${out.hits}× across your fleets`}
            {out.usage && ` · ${out.usage.used}/${out.usage.limit} today`}
          </p>
        </div>
      )}

      {out && out.status !== 'ok' && (
        <p className="fade-up mt-3 text-[12.5px] leading-relaxed text-[var(--color-fg-muted)]">
          {out.status === 'rate_limited'
            ? `That is ${out.limit} explanations today — the limit resets in ${Math.ceil((out.resetsInSec ?? 0) / 3600)} hours. Answers already generated are still free to read.`
            : out.reason}
        </p>
      )}

      {/* The evidence, always reachable, never replaced. */}
      <button
        onClick={() => setShowRaw((v) => !v)}
        className="mt-3 font-mono text-[10.5px] text-[var(--color-fg-dim)] underline-offset-4 transition-colors hover:text-[var(--color-fg)] hover:underline"
      >
        {showRaw ? '− hide the raw log' : '+ show the raw log'}
      </button>
      {showRaw && (
        <pre className="fade-up mt-2 max-h-[320px] overflow-auto bg-[var(--color-ink-900)] p-3 font-mono text-[10.5px] leading-relaxed text-[var(--color-fg-muted)]">
          {failureReason}
        </pre>
      )}
    </div>
  )
}
