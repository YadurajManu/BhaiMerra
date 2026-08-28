import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { api, type Service } from '../lib/api'
import { useAuth, usePoll } from '../lib/auth'
import { mb, toneOf } from '../lib/format'
import { Button, Copyable, Dot, Empty, ErrorNote, Panel, StatusPill } from '../components/ui'

const TEMPLATES: Record<string, string> = {
  nginx: `fleet: homelab

services:
  web:
    image: nginx:1.27-alpine
    placement: flexible
    port: 80
    resources: { ram: 128Mi, cpu: 0.2 }
    health: { path: / }
`,
  node: `fleet: homelab

services:
  api:
    repo: https://github.com/org/repo.git
    placement: flexible
    port: 3000
    resources: { ram: 256Mi, cpu: 0.5 }
    health: { path: /healthz }
    env:
      NODE_ENV: production
`,
  postgres: `fleet: homelab

services:
  db:
    image: postgres:16-alpine
    placement: pinned
    node: sayyestoheaven
    port: 5432
    volume: pgdata
    resources: { ram: 512Mi, cpu: 1.0 }
    health: { path: / }
`,
  fastapi: `fleet: homelab

services:
  ml-api:
    image: python:3.11-slim
    placement: flexible
    port: 8000
    resources: { ram: 512Mi, cpu: 1.0 }
    health: { path: /docs }
`,
  redis: `fleet: homelab

services:
  cache:
    image: redis:7-alpine
    placement: flexible
    port: 6379
    resources: { ram: 128Mi, cpu: 0.2 }
`,
}

type FilterStatus = 'ALL' | 'RUNNING' | 'STOPPED' | 'FLEXIBLE' | 'PINNED'

export default function Services() {
  const { fleet } = useAuth()
  const id = fleet?.id
  const canDeploy = fleet?.role !== 'viewer'
  const canEdit = fleet?.role === 'owner' || fleet?.role === 'admin'

  const { data, error, loading } = usePoll(() => api<{ services: Service[] }>(`/fleets/${id}/services`), [id])

  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('ALL')
  const [manifest, setManifest] = useState(TEMPLATES.nginx!)
  const [selectedTemplate, setSelectedTemplate] = useState('nginx')
  const [showEditor, setShowEditor] = useState(false)
  const [result, setResult] = useState<{ created?: string[]; updated?: string[]; warnings?: string[] } | null>(null)
  const [issues, setIssues] = useState<Array<{ path: string; message: string }> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<unknown>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)

  const services = useMemo(() => data?.services ?? [], [data])

  // Summary Metrics
  const metrics = useMemo(() => {
    const total = services.length
    const running = services.filter((s) => s.current?.status === 'running' || s.current?.status === 'online').length
    const unplaced = services.filter((s) => !s.current?.nodeName).length
    const totalRam = services.reduce((acc, s) => acc + (s.requestRamMb || 0), 0)
    return { total, running, unplaced, totalRam }
  }, [services])

  // Filtered Services
  const filteredServices = useMemo(() => {
    return services.filter((s) => {
      // Status & Placement filter
      if (filterStatus === 'RUNNING') {
        if (s.current?.status !== 'running' && s.current?.status !== 'online') return false
      } else if (filterStatus === 'STOPPED') {
        if (s.current?.status === 'running' || s.current?.status === 'online') return false
      } else if (filterStatus === 'FLEXIBLE') {
        if (s.placementPolicy !== 'flexible') return false
      } else if (filterStatus === 'PINNED') {
        if (s.placementPolicy !== 'pinned') return false
      }

      // Search Query filter
      if (!search.trim()) return true
      const q = search.toLowerCase()
      return (
        s.name.toLowerCase().includes(q) ||
        (s.domain ?? '').toLowerCase().includes(q) ||
        (s.hostname ?? '').toLowerCase().includes(q) ||
        (s.current?.nodeName ?? '').toLowerCase().includes(q) ||
        (s.repoUrl ?? '').toLowerCase().includes(q)
      )
    })
  }, [services, filterStatus, search])

  const handleTemplateChange = (tmplKey: string) => {
    setSelectedTemplate(tmplKey)
    if (TEMPLATES[tmplKey]) {
      setManifest(TEMPLATES[tmplKey])
      setIssues(null)
      setResult(null)
    }
  }

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
    setBusy(`deploy-${service.id}`)
    setActionError(null)
    setActionSuccess(null)
    try {
      await api(`/services/${service.id}/deploy`, { method: 'POST', body: {} })
      setActionSuccess(`Deployment initiated for ${service.name}`)
      setTimeout(() => setActionSuccess(null), 4000)
    } catch (err) {
      setActionError(err)
    } finally {
      setBusy(null)
    }
  }

  async function restart(service: Service) {
    setBusy(`restart-${service.id}`)
    setActionError(null)
    setActionSuccess(null)
    try {
      await api(`/services/${service.id}/restart`, { method: 'POST', body: {} })
      setActionSuccess(`Restart signal sent to ${service.name}`)
      setTimeout(() => setActionSuccess(null), 4000)
    } catch (err) {
      setActionError(err)
    } finally {
      setBusy(null)
    }
  }

  if (error) return <ErrorNote error={error} />

  return (
    <div className="space-y-6">
      {/* ── Page Header ─────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-mono text-[22px] font-semibold tracking-[-0.02em]">Services</h1>
          <p className="mt-1 text-[13.5px] text-[var(--color-fg-muted)]">
            Declared in <code className="text-[var(--color-fg)]">fleet.yaml</code> · Managed by the placement scheduler with automatic rolling deployments.
          </p>
        </div>
        {canEdit && (
          <Button
            variant={showEditor ? 'ghost' : 'primary'}
            onClick={() => setShowEditor(!showEditor)}
            className="h-[34px] px-4 font-mono text-[11.5px]"
          >
            {showEditor ? '✕ Close Editor' : '+ Apply fleet.yaml'}
          </Button>
        )}
      </div>

      {/* ── Notifications / Alerts ──────────────────────────────── */}
      <ErrorNote error={actionError} />

      {actionSuccess && (
        <div className="fade-up border-l-2 border-[var(--color-signal)] bg-[color-mix(in_oklab,var(--color-signal)_8%,transparent)] px-4 py-3 font-mono text-[12px] text-[var(--color-signal)]">
          ✓ {actionSuccess}
        </div>
      )}

      {/* ── Summary KPI Bar ─────────────────────────────────────── */}
      <div className="grid gap-px bg-[var(--color-line)] sm:grid-cols-2 lg:grid-cols-4">
        {[
          ['Total Services', String(metrics.total), 'idle'],
          ['Running Workloads', `${metrics.running} / ${metrics.total}`, metrics.running > 0 ? 'ok' : 'idle'],
          ['Memory Allocated', mb(metrics.totalRam), 'idle'],
          ['Unplaced', String(metrics.unplaced), metrics.unplaced > 0 ? 'warn' : 'idle'],
        ].map(([label, value, tone]) => (
          <div key={label} className="bg-[var(--color-ink-950)] px-5 py-3.5">
            <div className="mono-label normal-case tracking-[0.08em]">{label}</div>
            <div className="mt-1.5 flex items-center gap-2">
              {tone !== 'idle' && <Dot tone={tone as 'ok' | 'warn'} size={6} />}
              <span className="tabular font-mono text-[19px] font-semibold tracking-[-0.02em]">{value}</span>
            </div>
          </div>
        ))}
      </div>

      {/* ── Manifest YAML Editor Drawer ─────────────────────────── */}
      {showEditor && (
        <Panel
          title="Manifest Editor"
          right={
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase text-[var(--color-fg-dim)]">Template:</span>
              <select
                value={selectedTemplate}
                onChange={(e) => handleTemplateChange(e.target.value)}
                className="rounded-[3px] border border-[var(--color-line)] bg-[var(--color-ink-850)] px-2 py-0.5 font-mono text-[10.5px] text-[var(--color-fg)] outline-none"
              >
                <option value="nginx">Nginx Web Server</option>
                <option value="node">Node.js API</option>
                <option value="postgres">PostgreSQL Database</option>
                <option value="fastapi">Python / FastAPI</option>
                <option value="redis">Redis Cache</option>
              </select>
            </div>
          }
          className="fade-up"
        >
          <div className="p-5">
            <textarea
              value={manifest}
              onChange={(e) => setManifest(e.target.value)}
              spellCheck={false}
              rows={14}
              className="no-scrollbar w-full resize-y rounded-[3px] border border-[var(--color-line)] bg-[#07080a] p-4 font-mono text-[12px] leading-[1.7] text-[var(--color-fg)] outline-none focus:border-[var(--color-line-2)]"
            />
            <p className="mt-3 text-[12px] leading-relaxed text-[var(--color-fg-dim)]">
              <code>Apply</code> commits the service definitions to the database. Click <code>Deploy</code> afterwards to trigger image pulling and scheduler placement.
            </p>

            {issues && (
              <div className="mt-4 border-l-2 border-[var(--color-down)] bg-[color-mix(in_oklab,var(--color-down)_6%,transparent)] px-4 py-3">
                <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-down)]">
                  {issues.length} Manifest Issue{issues.length === 1 ? '' : 's'}
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
                  <p className="font-mono text-[11.5px] text-[var(--color-signal)]">
                    ✓ Created: {result.created.join(', ')}
                  </p>
                )}
                {!!result.updated?.length && (
                  <p className="font-mono text-[11.5px] text-[var(--color-fg-muted)]">
                    ✓ Updated: {result.updated.join(', ')}
                  </p>
                )}
                {result.warnings?.map((w) => (
                  <p key={w} className="border-l-2 border-[var(--color-warn)] py-1 pl-3 text-[12.5px] text-[var(--color-fg-muted)]">
                    ▲ {w}
                  </p>
                ))}
              </div>
            )}

            <div className="mt-4 flex gap-2.5">
              <Button onClick={() => void validate()} disabled={busy !== null}>
                {busy === 'validate' ? 'Validating…' : 'Validate YAML'}
              </Button>
              <Button variant="primary" onClick={() => void apply()} disabled={busy !== null}>
                {busy === 'apply' ? 'Applying…' : 'Apply to Fleet'}
              </Button>
            </div>
          </div>
        </Panel>
      )}

      {/* ── Search & Filter Toolbar ─────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-line)] pb-3">
        {/* Status Filters */}
        <div className="flex items-center gap-1 font-mono text-[11px]">
          {(
            [
              ['ALL', `All (${services.length})`],
              ['RUNNING', `Running (${metrics.running})`],
              ['STOPPED', `Stopped (${metrics.total - metrics.running})`],
              ['FLEXIBLE', `Flexible`],
              ['PINNED', `Pinned`],
            ] as const
          ).map(([statusKey, label]) => (
            <button
              key={statusKey}
              onClick={() => setFilterStatus(statusKey)}
              className={`rounded-[3px] px-2.5 py-1 transition-colors ${
                filterStatus === statusKey
                  ? 'bg-[var(--color-ink-800)] font-medium text-[var(--color-fg)]'
                  : 'text-[var(--color-fg-dim)] hover:text-[var(--color-fg-muted)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Search Input */}
        <div className="relative flex items-center">
          <span className="pointer-events-none absolute left-2.5 text-[11px] text-[var(--color-fg-dim)]">🔍</span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search services, nodes, domains…"
            className="h-[30px] w-[220px] rounded-[3px] border border-[var(--color-line)] bg-[var(--color-ink-900)] pl-7 pr-7 font-mono text-[11.5px] text-[var(--color-fg)] outline-none transition-all placeholder:text-[var(--color-fg-dim)] focus:w-[280px] focus:border-[var(--color-line-2)]"
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
      </div>

      {/* ── Services Cards List ─────────────────────────────────── */}
      {!loading && !services.length ? (
        <Empty
          title="No services in this fleet"
          hint="Apply a fleet.yaml manifest to declare container workloads, ports, memory requirements, and placement rules."
          action={
            <Button variant="primary" onClick={() => setShowEditor(true)}>
              Create Your First Service
            </Button>
          }
        />
      ) : filteredServices.length === 0 ? (
        <div className="py-12 text-center font-mono text-[12px] text-[var(--color-fg-dim)]">
          No services match your filter "{search || filterStatus}".
          <button
            onClick={() => {
              setSearch('')
              setFilterStatus('ALL')
            }}
            className="ml-2 text-[var(--color-signal)] underline hover:text-[#55ee9c]"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="grid gap-3">
          {filteredServices.map((s) => {
            const url = s.domain || s.hostname ? `https://${s.domain ?? s.hostname}` : null
            const isRunning = s.current?.status === 'running' || s.current?.status === 'online'
            const isDeploying = busy === `deploy-${s.id}`
            const isRestarting = busy === `restart-${s.id}`

            return (
              <div
                key={s.id}
                className="panel flex flex-col justify-between gap-4 rounded-[4px] bg-[var(--color-ink-950)] p-5 transition-all duration-200 hover:border-[var(--color-line-2)]"
              >
                {/* ── Top Header Row ─────────────────────────────── */}
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <Link
                        to={`/services/${s.id}`}
                        className="font-mono text-[15px] font-semibold text-[var(--color-fg)] transition-colors hover:text-[var(--color-signal)]"
                      >
                        {s.name}
                      </Link>

                      {/* Placement Policy Badge */}
                      <span
                        className={`rounded-[3px] border px-2 py-0.5 font-mono text-[10px] ${
                          s.placementPolicy === 'pinned'
                            ? 'border-[var(--color-warn)] bg-[color-mix(in_oklab,var(--color-warn)_10%,transparent)] text-[var(--color-warn)]'
                            : 'border-[var(--color-line-2)] bg-[var(--color-ink-850)] text-[var(--color-fg-muted)]'
                        }`}
                      >
                        {s.placementPolicy}
                      </span>

                      {/* Volume Badge */}
                      {s.persistentVolume && (
                        <span className="inline-flex items-center gap-1 rounded-[3px] border border-[var(--color-line-2)] bg-[var(--color-ink-850)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-fg-muted)]">
                          ⛁ {s.volumeName || 'volume'}
                        </span>
                      )}

                      {/* GPU Badge */}
                      {s.requiresGpu && (
                        <span className="rounded-[3px] border border-[var(--color-signal-dim)] bg-[color-mix(in_oklab,var(--color-signal)_10%,transparent)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-signal)]">
                          ⚡ GPU
                        </span>
                      )}
                    </div>

                    {/* Repository / Image Info */}
                    <div className="mt-1.5 flex flex-wrap items-center gap-3 font-mono text-[11px] text-[var(--color-fg-dim)]">
                      {s.repoUrl ? (
                        <a
                          href={s.repoUrl.replace(/\.git$/, '')}
                          target="_blank"
                          rel="noreferrer"
                          className="truncate hover:text-[var(--color-fg-muted)]"
                          title="Open Git Repository"
                        >
                          📦 {s.repoUrl.replace('https://github.com/', '')}
                        </a>
                      ) : (
                        <span>📦 Image: manual</span>
                      )}
                    </div>
                  </div>

                  {/* Status Pill */}
                  <div className="shrink-0">
                    {s.current ? (
                      <StatusPill status={s.current.status} />
                    ) : (
                      <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.1em] text-[var(--color-fg-dim)]">
                        <Dot tone="idle" size={5} />
                        not placed
                      </span>
                    )}
                  </div>
                </div>

                {/* ── Middle Row: Public URL & Node Placement ────── */}
                <div className="grid gap-3 rounded-[3px] border border-[var(--color-line)] bg-[var(--color-ink-900)] p-3.5 sm:grid-cols-[1fr_auto]">
                  <div className="min-w-0">
                    <div className="mono-label text-[9px] mb-1 text-[var(--color-fg-dim)]">PUBLIC ENDPOINT</div>
                    {url ? (
                      <div className="flex items-center gap-2.5">
                        <a
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          className="truncate font-mono text-[12px] text-[var(--color-signal)] transition-colors hover:underline hover:text-[#55ee9c]"
                          title="Open live endpoint in browser"
                        >
                          {url} ↗
                        </a>
                        <Copyable text={url} className="shrink-0" />
                      </div>
                    ) : (
                      <span className="font-mono text-[11px] text-[var(--color-fg-dim)]">No public domain attached</span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-4 font-mono text-[11px] text-[var(--color-fg-muted)] border-t border-[var(--color-line)] pt-2 sm:border-t-0 sm:pt-0 sm:border-l sm:pl-4">
                    <div>
                      <span className="block mono-label text-[9px] text-[var(--color-fg-dim)]">NODE</span>
                      <span className="font-medium text-[var(--color-fg)]">
                        {s.current?.nodeName ? (
                          <span className="inline-flex items-center gap-1">
                            <Dot tone={toneOf(s.current.status)} size={4} />
                            {s.current.nodeName}
                          </span>
                        ) : (
                          <span className="text-[var(--color-fg-dim)]">unplaced</span>
                        )}
                      </span>
                    </div>

                    <div>
                      <span className="block mono-label text-[9px] text-[var(--color-fg-dim)]">RAM</span>
                      <span>{mb(s.requestRamMb)}</span>
                    </div>

                    <div>
                      <span className="block mono-label text-[9px] text-[var(--color-fg-dim)]">REPLICAS</span>
                      <span>{s.replicas}</span>
                    </div>

                    {s.current?.gitSha && (
                      <div>
                        <span className="block mono-label text-[9px] text-[var(--color-fg-dim)]">VERSION</span>
                        <span className="rounded-[2px] border border-[var(--color-line-2)] bg-[var(--color-ink-950)] px-1 py-0.5 text-[10px]">
                          {s.current.gitSha.slice(0, 7)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* ── Bottom Action Bar ──────────────────────────── */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-line)] pt-3">
                  <div className="flex items-center gap-2">
                    <Link
                      to={`/logs?service=${s.id}`}
                      className="inline-flex items-center gap-1.5 rounded-[3px] border border-[var(--color-line-2)] bg-[var(--color-ink-900)] px-3 py-1 font-mono text-[11px] text-[var(--color-fg-muted)] transition-colors hover:border-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
                    >
                      📜 Live Logs
                    </Link>

                    <Link
                      to={`/services/${s.id}`}
                      className="inline-flex items-center gap-1 rounded-[3px] border border-[var(--color-line-2)] bg-[var(--color-ink-900)] px-3 py-1 font-mono text-[11px] text-[var(--color-fg-muted)] transition-colors hover:border-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
                    >
                      🔍 Inspect →
                    </Link>
                  </div>

                  {canDeploy && (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => void restart(s)}
                        disabled={busy !== null || !isRunning}
                        title={!isRunning ? 'Service is not running' : 'Restart container on current node'}
                        className="inline-flex items-center gap-1.5 rounded-[3px] border border-[var(--color-line-2)] bg-[var(--color-ink-900)] px-3 py-1 font-mono text-[11px] text-[var(--color-fg-muted)] transition-colors hover:border-[var(--color-fg-dim)] hover:text-[var(--color-fg)] disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {isRestarting ? 'Restarting…' : '⚡ Restart'}
                      </button>

                      <Button
                        variant="primary"
                        onClick={() => void deploy(s)}
                        disabled={busy !== null}
                        className="h-[30px] px-3.5 text-[11px]"
                      >
                        {isDeploying ? 'Deploying…' : '🚀 Deploy'}
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
