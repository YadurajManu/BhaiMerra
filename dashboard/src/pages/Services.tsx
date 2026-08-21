import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type Service } from '../lib/api'
import { useAuth, usePoll } from '../lib/auth'
import { mb } from '../lib/format'
import { Button, Copyable, Empty, ErrorNote, Panel, StatusPill } from '../components/ui'

const SAMPLE = `fleet: homelab

services:
  web:
    repo: https://github.com/you/homelab.git
    image: nginx:1.27
    placement: flexible
    port: 80
    resources: { ram: 512Mi }
`

export default function Services() {
  const { fleet } = useAuth()
  const id = fleet?.id
  const canDeploy = fleet?.role !== 'viewer'
  const canEdit = fleet?.role === 'owner' || fleet?.role === 'admin'

  const { data, error, loading } = usePoll(() => api<{ services: Service[] }>(`/fleets/${id}/services`), [id])

  const [manifest, setManifest] = useState(SAMPLE)
  const [showEditor, setShowEditor] = useState(false)
  const [result, setResult] = useState<{ created?: string[]; updated?: string[]; warnings?: string[] } | null>(null)
  const [issues, setIssues] = useState<Array<{ path: string; message: string }> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<unknown>(null)

  async function validate() {
    setBusy('validate')
    setIssues(null)
    setResult(null)
    setActionError(null)
    try {
      const res = await api<{ valid: boolean; issues?: typeof issues; warnings?: string[] }>(
        `/fleets/${id}/services/validate`,
        { method: 'POST', body: { manifest } }
      )
      if (!res.valid) setIssues(res.issues ?? [])
      else setResult({ warnings: res.warnings })
    } catch (err) {
      setActionError(err)
    } finally {
      setBusy(null)
    }
  }

  async function apply() {
    setBusy('apply')
    setIssues(null)
    setActionError(null)
    try {
      setResult(await api(`/fleets/${id}/services`, { method: 'POST', body: { manifest } }))
    } catch (err) {
      const detail = (err as { detail?: unknown }).detail
      if (Array.isArray(detail)) setIssues(detail as Array<{ path: string; message: string }>)
      else setActionError(err)
    } finally {
      setBusy(null)
    }
  }

  async function deploy(service: Service) {
    setBusy(service.id)
    setActionError(null)
    try {
      await api(`/services/${service.id}/deploy`, { method: 'POST', body: {} })
    } catch (err) {
      setActionError(err)
    } finally {
      setBusy(null)
    }
  }

  if (error) return <ErrorNote error={error} />
  const services = data?.services ?? []

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.03em]">Services</h1>
          <p className="mt-1 text-[13.5px] text-[var(--color-fg-muted)]">
            Declared in fleet.yaml, placed by the scheduler. Add <code>repo:</code> to deploy the exact YAML and code from a GitHub push.
          </p>
        </div>
        {canEdit && (
          <Button variant={showEditor ? 'ghost' : 'primary'} onClick={() => setShowEditor(!showEditor)}>
            {showEditor ? 'Close editor' : 'Apply fleet.yaml'}
          </Button>
        )}
      </div>

      <ErrorNote error={actionError} />

      {showEditor && (
        <Panel title="fleet.yaml" className="fade-up">
          <div className="p-5">
            <textarea
              value={manifest}
              onChange={(e) => setManifest(e.target.value)}
              spellCheck={false}
              rows={16}
              className="no-scrollbar w-full resize-y rounded-[3px] border border-[var(--color-line)] bg-[#07080a] p-4 font-mono text-[12px] leading-[1.7] text-[var(--color-fg-muted)] outline-none focus:border-[var(--color-line-2)]"
            />
            <p className="mt-3 text-[12px] leading-relaxed text-[var(--color-fg-dim)]">
              <code>Apply</code> saves the desired services. It does not deploy them; use <code>Deploy</code> after applying. With a
              <code>repo</code> field, GitHub pushes fetch that commit, apply its <code>fleet.yaml</code>, then redeploy its services.
            </p>

            {issues && (
              <div className="mt-4 border-l-2 border-[var(--color-down)] bg-[color-mix(in_oklab,var(--color-down)_6%,transparent)] px-4 py-3">
                <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-down)]">
                  {issues.length} problem{issues.length === 1 ? '' : 's'}
                </div>
                <ul className="mt-2 space-y-1.5">
                  {issues.map((i, k) => (
                    <li key={k} className="font-mono text-[11.5px]">
                      <span className="text-[var(--color-fg)]">{i.path}</span>
                      <span className="block pl-4 text-[var(--color-fg-muted)]">{i.message}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {result && (
              <div className="mt-4 space-y-2">
                {!!result.created?.length && (
                  <p className="font-mono text-[11.5px] text-[var(--color-signal)]">created {result.created.join(', ')}</p>
                )}
                {!!result.updated?.length && (
                  <p className="font-mono text-[11.5px] text-[var(--color-fg-muted)]">updated {result.updated.join(', ')}</p>
                )}
                {result.warnings?.map((w) => (
                  <p key={w} className="border-l-2 border-[var(--color-warn)] py-1 pl-3 text-[12.5px] text-[var(--color-fg-muted)]">
                    {w}
                  </p>
                ))}
              </div>
            )}

            <div className="mt-4 flex gap-2">
              <Button onClick={() => void validate()} disabled={busy !== null}>
                {busy === 'validate' ? 'checking…' : 'Validate'}
              </Button>
              <Button variant="primary" onClick={() => void apply()} disabled={busy !== null}>
                {busy === 'apply' ? 'applying…' : 'Apply'}
              </Button>
            </div>
          </div>
        </Panel>
      )}

      {!loading && !services.length ? (
        <Empty title="No services yet" hint="Apply a fleet.yaml to declare what should run and where it may run." />
      ) : (
        <Panel>
          <div className="divide-y divide-[var(--color-line)]">
            {services.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                <div className="min-w-[180px] flex-1">
                  <Link
                    to={`/services/${s.id}`}
                    className="font-mono text-[13.5px] transition-colors hover:text-[var(--color-signal)]"
                  >
                    {s.name}
                  </Link>
                  {s.persistentVolume && (
                    <span className="ml-2 font-mono text-[9.5px] text-[var(--color-fg-dim)]" title={`volume ${s.volumeName}`}>
                      ⛁ {s.volumeName}
                    </span>
                  )}
                  <div className="mt-1 font-mono text-[10px] text-[var(--color-fg-dim)]">
                    {s.placementPolicy} · {mb(s.requestRamMb)}
                    {s.requiresGpu && ' · gpu'}
                  </div>
                  {s.repoUrl?.startsWith('https://') && (
                    <a
                      href={s.repoUrl.replace(/\.git$/, '')}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 block truncate font-mono text-[10px] text-[var(--color-fg-dim)] hover:text-[var(--color-signal)]"
                      title="Open source repository"
                    >
                      {s.repoUrl}
                    </a>
                  )}
                  {s.repoUrl && !s.repoUrl.startsWith('https://') && (
                    <span className="mt-1 block truncate font-mono text-[10px] text-[var(--color-fg-dim)]">{s.repoUrl}</span>
                  )}
                </div>

                <div className="min-w-[200px] flex-1">
                  {s.domain || s.hostname ? (
                    <div className="flex items-center gap-3">
                      <a
                        href={`https://${s.domain ?? s.hostname}`}
                        target="_blank"
                        rel="noreferrer"
                        className="truncate font-mono text-[11.5px] text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-signal)]"
                        title="Open public service"
                      >
                        https://{s.domain ?? s.hostname}
                      </a>
                      <Copyable text={`https://${s.domain ?? s.hostname}`} className="shrink-0" />
                    </div>
                  ) : (
                    <span className="font-mono text-[11px] text-[var(--color-fg-dim)]">no hostname</span>
                  )}
                </div>

                <div className="min-w-[120px] font-mono text-[11.5px] text-[var(--color-fg-muted)]">
                  {s.current?.nodeName ?? <span className="text-[var(--color-fg-dim)]">unplaced</span>}
                </div>

                <div className="min-w-[110px]">
                  {s.current ? (
                    <StatusPill status={s.current.status} />
                  ) : (
                    <span className="font-mono text-[10.5px] text-[var(--color-fg-dim)]">not deployed</span>
                  )}
                </div>

                {canDeploy && (
                  <Button onClick={() => void deploy(s)} disabled={busy === s.id}>
                    {busy === s.id ? 'deploying…' : 'Deploy'}
                  </Button>
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  )
}
