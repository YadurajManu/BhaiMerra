import { useParams, Link } from 'react-router-dom'
import { api, type Deployment, type Service } from '../lib/api'
import { useAuth, usePoll } from '../lib/auth'
import { mb, since } from '../lib/format'
import { Button, Copyable, ErrorNote, Panel, StatusPill } from '../components/ui'
import { useState } from 'react'

type Preview = {
  decision:
    | {
        outcome: 'placed'
        nodeName: string
        candidates: Array<{ nodeName: string; score: number; breakdown: { headroom: number; reliability: number; load: number }; freeRamMb: number }>
        rejected: Array<{ nodeName: string; code: string; detail: string }>
      }
    | { outcome: 'no_eligible_node'; summary: string; rejected: Array<{ nodeName: string; code: string; detail: string }> }
}

export default function ServiceDetail() {
  const { serviceId } = useParams()
  const { fleet } = useAuth()
  const canDeploy = fleet?.role !== 'viewer'
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<unknown>(null)

  const services = usePoll(() => api<{ services: Service[] }>(`/fleets/${fleet?.id}/services`), [fleet?.id])
  const deployments = usePoll(
    () => api<{ deployments: Deployment[] }>(`/services/${serviceId}/deployments`),
    [serviceId],
    8000
  )
  const preview = usePoll(() => api<Preview>(`/services/${serviceId}/placement-preview`), [serviceId], 10000)

  const service = services.data?.services.find((s) => s.id === serviceId)

  async function act(path: string, key: string) {
    setBusy(key)
    setActionError(null)
    try {
      await api(path, { method: 'POST', body: {} })
    } catch (err) {
      setActionError(err)
    } finally {
      setBusy(null)
    }
  }

  if (!service) return <p className="font-mono text-[12px] text-[var(--color-fg-dim)]">loading…</p>
  const decision = preview.data?.decision

  return (
    <div className="space-y-6">
      <div>
        <Link to="/services" className="font-mono text-[11px] text-[var(--color-fg-dim)] hover:text-[var(--color-fg-muted)]">
          ← services
        </Link>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-mono text-[22px] tracking-[-0.02em]">{service.name}</h1>
            <div className="mt-2">
              {service.domain || service.hostname ? (
                <Copyable text={`http://${service.domain ?? service.hostname}`} />
              ) : (
                <span className="font-mono text-[11px] text-[var(--color-fg-dim)]">no hostname assigned</span>
              )}
            </div>
          </div>
          {canDeploy && (
            <div className="flex gap-2">
              <Button onClick={() => void act(`/services/${serviceId}/deploy`, 'deploy')} disabled={busy !== null}>
                {busy === 'deploy' ? 'deploying…' : 'Deploy'}
              </Button>
              <Button
                onClick={() => void act(`/services/${serviceId}/reschedule`, 'move')}
                disabled={busy !== null || service.placementPolicy === 'pinned'}
                title={
                  service.placementPolicy === 'pinned'
                    ? 'Pinned services are never moved automatically or on request'
                    : 'Force a placement decision to be recomputed'
                }
              >
                {busy === 'move' ? 'moving…' : 'Reschedule'}
              </Button>
            </div>
          )}
        </div>
      </div>

      <ErrorNote error={actionError} />

      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <Panel title="declared">
          <dl className="divide-y divide-[var(--color-line)]">
            {[
              ['placement', service.placementPolicy],
              ['ram request', mb(service.requestRamMb)],
              ['architectures', service.compatibleArches.length ? service.compatibleArches.join(', ') : 'any'],
              ['min reliability', service.minReliabilityTier],
              ['gpu', service.requiresGpu ? 'required' : 'not required'],
              ['volume', service.persistentVolume ? (service.volumeName ?? 'yes') : 'none'],
              ['replicas', String(service.replicas)],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-4 px-5 py-2.5">
                <dt className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-[var(--color-fg-dim)]">{k}</dt>
                <dd className="font-mono text-[12px] text-[var(--color-fg-muted)]">{v}</dd>
              </div>
            ))}
          </dl>
        </Panel>

        {/* Why here, and where it would go next — the scheduler, made legible. */}
        <Panel title="placement decision">
          {!decision ? (
            <p className="px-5 py-6 font-mono text-[11px] text-[var(--color-fg-dim)]">computing…</p>
          ) : decision.outcome === 'no_eligible_node' ? (
            <div className="p-5">
              <p className="text-[13.5px] text-[var(--color-down)]">No eligible node</p>
              <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--color-fg-muted)]">{decision.summary}</p>
              <ul className="mt-4 space-y-1.5">
                {decision.rejected.map((r) => (
                  <li key={r.nodeName} className="font-mono text-[11px]">
                    <span className="text-[var(--color-fg-muted)]">{r.nodeName}</span>{' '}
                    <span className="text-[var(--color-fg-dim)]">{r.code}</span>
                    <span className="block pl-3 text-[10.5px] text-[var(--color-fg-dim)]">{r.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="p-5">
              <p className="font-mono text-[12px]">
                would place on <span className="text-[var(--color-signal)]">{decision.nodeName}</span>
              </p>
              <table className="mt-4 w-full text-left">
                <thead>
                  <tr>
                    {['node', 'score', 'headroom', 'tier', 'load', 'free'].map((h) => (
                      <th key={h} className="pb-2 font-mono text-[9.5px] uppercase tracking-[0.1em] text-[var(--color-fg-dim)]">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {decision.candidates.map((c, i) => (
                    <tr key={c.nodeName} className={i === 0 ? 'text-[var(--color-fg)]' : 'text-[var(--color-fg-muted)]'}>
                      <td className="py-1 font-mono text-[11.5px]">{c.nodeName}</td>
                      <td className="tabular py-1 font-mono text-[11.5px]">{c.score.toFixed(4)}</td>
                      <td className="tabular py-1 font-mono text-[11px]">{c.breakdown.headroom.toFixed(3)}</td>
                      <td className="tabular py-1 font-mono text-[11px]">{c.breakdown.reliability.toFixed(2)}</td>
                      <td className="tabular py-1 font-mono text-[11px]">{c.breakdown.load.toFixed(2)}</td>
                      <td className="tabular py-1 font-mono text-[11px]">{mb(c.freeRamMb)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {decision.rejected.length > 0 && (
                <details className="mt-4">
                  <summary className="cursor-pointer font-mono text-[10.5px] text-[var(--color-fg-dim)]">
                    {decision.rejected.length} node(s) not eligible
                  </summary>
                  <ul className="mt-2 space-y-1">
                    {decision.rejected.map((r) => (
                      <li key={r.nodeName} className="font-mono text-[10.5px] text-[var(--color-fg-dim)]">
                        {r.nodeName} — {r.detail}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </Panel>
      </div>

      <Panel title="deployments">
        <div className="divide-y divide-[var(--color-line)]">
          {(deployments.data?.deployments ?? []).map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-4 px-5 py-3">
              <span className="min-w-[90px] font-mono text-[11px] text-[var(--color-fg-dim)]">{since(d.startedAt)}</span>
              <span className="min-w-[70px] font-mono text-[11.5px]">{d.gitSha?.slice(0, 7) ?? '—'}</span>
              <span className="min-w-[120px] font-mono text-[11.5px] text-[var(--color-fg-muted)]">{d.nodeName ?? '—'}</span>
              <StatusPill status={d.status} />
              {d.failureReason && (
                <span className="font-mono text-[10.5px] text-[var(--color-down)]">{d.failureReason}</span>
              )}
              <span className="ml-auto truncate font-mono text-[10px] text-[var(--color-fg-dim)]">{d.imageTags[0]}</span>
            </div>
          ))}
          {!deployments.data?.deployments.length && (
            <p className="px-5 py-8 text-center font-mono text-[11px] text-[var(--color-fg-dim)]">
              never deployed
            </p>
          )}
        </div>
      </Panel>
    </div>
  )
}
