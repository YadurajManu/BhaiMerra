import { useParams, Link, useNavigate } from 'react-router-dom'
import { api, type Deployment, type Service } from '../lib/api'
import { useAuth, usePoll } from '../lib/auth'
import { mb, since } from '../lib/format'
import { Button, ConfirmDialog, Copyable, ErrorNote, Panel, StatusPill } from '../components/ui'
import LogTerminal from '../components/LogTerminal'
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
  const navigate = useNavigate()
  const { fleet } = useAuth()
  const canDeploy = fleet?.role !== 'viewer'
  // Deletion is gated on admin to match the API's `service.update` requirement.
  // The button being hidden is a courtesy; the route guard is the control.
  const canEdit = fleet?.role === 'owner' || fleet?.role === 'admin'
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<unknown>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const services = usePoll(() => api<{ services: Service[] }>(`/fleets/${fleet?.id}/services`), [fleet?.id])
  const deployments = usePoll(
    () => api<{ deployments: Deployment[] }>(`/services/${serviceId}/deployments`),
    [serviceId],
    8000
  )
  const preview = usePoll(() => api<Preview>(`/services/${serviceId}/placement-preview`), [serviceId], 10000)
  const logs = usePoll(() => api<{ node: { name: string }; lines: string[]; diagnostic: string | null }>(`/services/${serviceId}/logs`), [serviceId], 2000)

  const service = services.data?.services.find((s) => s.id === serviceId)

  /**
   * Actions that change what is currently serving, and what to say about them.
   *
   * Rollback used to be guarded by window.confirm — an unstyled browser box on
   * an action that replaces the running release — while delete, which is no
   * more consequential, got the real dialog. Stop had no guard at all, and on
   * a stateful service it supersedes the release immediately: this session
   * logged five of them, several landing on top of a running deploy.
   */
  const GUARDED: Record<string, { title: string; body: string; consequences: string[]; confirmLabel: string }> = {
    rollback: {
      title: `Roll back ${service?.name ?? 'service'}`,
      body: 'The previous release is redeployed and becomes the live one.',
      consequences: [
        'The release running now is superseded, not deleted',
        'Its container is replaced on the node it runs on',
        'The rollback is itself a deployment, and can be rolled back',
      ],
      confirmLabel: 'Roll back',
    },
    stop: {
      title: `Stop ${service?.name ?? 'service'}`,
      body: 'Its containers are torn down and the service stops serving.',
      consequences: [
        'The public URL stops answering immediately',
        'A service holding a volume goes down without a replacement standing by',
        'Deploy brings it back; nothing is deleted',
      ],
      confirmLabel: 'Stop service',
    },
  }
  const [confirming, setConfirming] = useState<{ path: string; key: string } | null>(null)

  async function act(path: string, key: string) {
    // Anything that takes down what is serving asks first.
    if (GUARDED[key] && !confirming) {
      setConfirming({ path, key })
      return
    }
    setConfirming(null)
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

  /**
   * Delete the service and leave the page. Staying would poll a service that no
   * longer exists and fall through to the "loading…" branch forever, which reads
   * as a hang rather than as success.
   */
  async function deleteService() {
    setBusy('delete')
    setActionError(null)
    try {
      await api(`/services/${serviceId}`, { method: 'DELETE' })
      setConfirmDelete(false)
      void navigate('/services')
    } catch (err) {
      setActionError(err)
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
                <div className="flex items-center gap-3">
                  <a
                    href={`https://${service.domain ?? service.hostname}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-[11.5px] text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-signal)]"
                  >
                    https://{service.domain ?? service.hostname}
                  </a>
                  <Copyable text={`https://${service.domain ?? service.hostname}`} />
                </div>
              ) : (
                <span className="font-mono text-[11px] text-[var(--color-fg-dim)]">no hostname assigned</span>
              )}
            </div>
          </div>
          {/* Two groups, separated by a rule.
              Left: things that bring a service up or move it. Right: things
              that take down what is currently serving. They were one flat row
              of equal weight, so Stop sat between Deploy and Restart and
              looked exactly like them. */}
          {canDeploy && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={() => void act(`/services/${serviceId}/deploy`, 'deploy')} disabled={busy !== null}>
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
              <Button onClick={() => void act(`/services/${serviceId}/restart`, 'restart')} disabled={busy !== null}>
                {busy === 'restart' ? 'restarting…' : 'Restart'}
              </Button>

              <span aria-hidden="true" className="mx-1 h-5 w-px self-center bg-[var(--color-line-2)]" />

              <Button
                onClick={() => void act(`/services/${serviceId}/stop`, 'stop')}
                disabled={busy !== null}
                title="Tear down the running containers"
              >
                {busy === 'stop' ? 'stopping…' : 'Stop'}
              </Button>
              <Button variant="danger" onClick={() => void act(`/services/${serviceId}/rollback`, 'rollback')} disabled={busy !== null}>
                {busy === 'rollback' ? 'rolling back…' : 'Rollback'}
              </Button>
              {canEdit && (
                <Button
                  variant="danger"
                  onClick={() => setConfirmDelete(true)}
                  disabled={busy !== null}
                  title="Permanently remove this service from the fleet"
                >
                  {busy === 'delete' ? 'deleting…' : 'Delete Service'}
                </Button>
              )}
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
              ['repository', service.repoUrl ?? 'manual / image-only'],
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

      <LogTerminal
        serviceName={service.name}
        nodeName={logs.data?.node?.name}
        lines={logs.data?.lines ?? []}
        diagnostic={logs.data?.diagnostic ?? null}
        loading={logs.loading}
        isLive={true}
        height="420px"
      />

      {/* Rollback and Stop, with the same weight delete has always had. */}
      <ConfirmDialog
        open={confirming !== null}
        title={confirming ? GUARDED[confirming.key]!.title : ''}
        body={confirming ? GUARDED[confirming.key]!.body : ''}
        consequences={confirming ? GUARDED[confirming.key]!.consequences : []}
        confirmLabel={confirming ? GUARDED[confirming.key]!.confirmLabel : ''}
        busy={busy === confirming?.key}
        onConfirm={() => {
          if (confirming) void act(confirming.path, confirming.key)
        }}
        onCancel={() => setConfirming(null)}
      />

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${service.name}`}
        body="This removes the service from the fleet. It cannot be undone from the dashboard."
        consequences={[
          'Its container is removed from the node it runs on',
          'Its deployment history and URL are released',
          'To stop it without deleting it, use Stop instead',
        ]}
        confirmPhrase={service.name}
        confirmLabel="Delete service"
        busy={busy === 'delete'}
        onConfirm={() => void deleteService()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  )
}
