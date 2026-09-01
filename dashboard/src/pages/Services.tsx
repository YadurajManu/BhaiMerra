import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { api, type Service } from '../lib/api'
import { useAuth, usePoll } from '../lib/auth'
import { mb, since, toneOf } from '../lib/format'

/**
 * What is going on with this service, in a sentence.
 *
 * The list used to render "not placed" for everything that was not currently
 * running — accurate and useless. It could not do better, because the reason a
 * deployment failed was never sent to the browser; finding out meant opening a
 * shell on the node, which is the thing a control plane exists to avoid.
 *
 * `current` answers "is it up". `last` answers "and if not, what happened".
 */
function describeState(s: Service): {
  label: string
  tone: 'ok' | 'warn' | 'down' | 'idle'
  when: string | null
  detail: string | null
  busy: boolean
} {
  const live = s.current?.status
  if (live === 'running' || live === 'online') {
    return { label: 'running', tone: 'ok', when: s.last ? since(s.last.startedAt) : null, detail: null, busy: false }
  }
  if (live === 'deploying') {
    return { label: 'deploying', tone: 'warn', when: s.last ? since(s.last.startedAt) : null, detail: null, busy: true }
  }
  if (live === 'pinned_unavailable') {
    return {
      label: 'node unavailable',
      tone: 'down',
      when: s.last ? since(s.last.startedAt) : null,
      // Not a failure of the service. Saying so prevents an hour spent
      // debugging an application that never got the chance to start.
      detail: `Pinned to ${s.last?.nodeName ?? 'a node'}, which is not reporting. A pinned service is deliberately never moved — its volume does not follow it.`,
      busy: false,
    }
  }

  if (!s.last) {
    return { label: 'never deployed', tone: 'idle', when: null, detail: null, busy: false }
  }
  if (s.last.status === 'failed') {
    return {
      label: 'failed',
      tone: 'down',
      when: since(s.last.finishedAt ?? s.last.startedAt),
      detail: s.last.failureReason,
      busy: false,
    }
  }
  if (s.last.status === 'superseded') {
    return { label: 'stopped', tone: 'idle', when: since(s.last.startedAt), detail: null, busy: false }
  }
  return { label: s.last.status.replace(/_/g, ' '), tone: 'idle', when: since(s.last.startedAt), detail: null, busy: false }
}

/** A build failure carries a whole buildx transcript; lead with the sentence. */
function summarise(reason: string): { head: string; rest: string | null } {
  const lines = reason.split('\n').filter((l) => l.trim())
  const head = lines[0] ?? reason
  const rest = lines.length > 1 ? lines.slice(1).join('\n') : null
  return { head: head.length > 200 ? `${head.slice(0, 197)}…` : head, rest }
}
import { Button, ConfirmDialog, Copyable, Dot, Empty, ErrorNote, Panel, StatusPill } from '../components/ui'

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
  const [copiedId, setCopiedId] = useState<string | null>(null)
  /** Which service has its failure reason expanded. One at a time. */
  const [openReason, setOpenReason] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Service | null>(null)

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

  // Filtered services, grouped by the manifest they came from.
  //
  // A fleet.yaml describes a stack. Rendering its services flat among every
  // other manifest's is how four related things came to look like four
  // unrelated ones — and how a service from a different project looked like
  // an orphan rather than simply somebody else's.
  const projects = useMemo(() => {
    const groups = new Map<string, Service[]>()
    for (const s of filteredServices) {
      const key = s.project || 'default'
      const group = groups.get(key) ?? []
      group.push(s)
      groups.set(key, group)
    }
    return [...groups]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, group]) => ({
        name,
        services: group,
        running: group.filter(
          (s) => s.current?.status === 'running' || s.current?.status === 'online'
        ).length,
        ram: group.reduce((sum, s) => sum + (s.requestRamMb || 0), 0),
      }))
  }, [filteredServices])

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

  async function stop(service: Service) {
    setBusy(`stop-${service.id}`)
    setActionError(null)
    setActionSuccess(null)
    try {
      await api(`/services/${service.id}/stop`, { method: 'POST', body: {} })
      setActionSuccess(`Stop signal sent. Containers for "${service.name}" will be removed.`)
      setTimeout(() => setActionSuccess(null), 4000)
    } catch (err) {
      setActionError(err)
    } finally {
      setBusy(null)
    }
  }

  async function deleteService(service: Service) {
    setBusy(`delete-${service.id}`)
    setActionError(null)
    setActionSuccess(null)
    try {
      const res = await api<{ stopped: number }>(`/services/${service.id}`, { method: 'DELETE' })
      setConfirmDelete(null)
      setActionSuccess(
        res.stopped
          ? `"${service.name}" deleted. Its container is being removed from the node.`
          : `"${service.name}" deleted.`
      )
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
              // "Stopped" is something a person does on purpose. A service
              // that failed its rollout did not stop, it broke, and calling
              // both the same word hides the only distinction that matters.
              ['STOPPED', `Not running (${metrics.total - metrics.running})`],
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
        <div className="grid gap-6">
          {projects.map((project, projectIndex) => {
          // A manifest is one thing. Four services from one fleet.yaml belong
          // inside one frame, the way a repository holds its files — not as
          // four free-floating cards that happen to sit near each other.
          const allUp = project.running === project.services.length
          const anyDown = project.services.some((s) => describeState(s).tone === 'down')
          const edge = allUp
            ? 'var(--color-signal)'
            : anyDown
              ? 'var(--color-down)'
              : 'var(--color-warn)'

          return (
          <section
            key={project.name}
            className="rise-in overflow-hidden rounded-[6px] border border-[var(--color-line)] bg-[var(--color-ink-900)]"
            style={{ animationDelay: `${Math.min(projectIndex, 6) * 55}ms` }}
          >
            {/* Project header — the stack's own summary line. */}
            <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-[var(--color-line)] bg-[var(--color-ink-850)] px-5 py-3.5">
              <div className="flex min-w-0 items-center gap-3">
                <span
                  aria-hidden="true"
                  className="h-6 w-[3px] shrink-0 rounded-full"
                  style={{ background: edge }}
                />
                <div className="min-w-0">
                  <h2 className="truncate font-mono text-[14px] font-semibold tracking-tight text-[var(--color-fg)]">
                    {project.name}
                  </h2>
                  <p className="mt-0.5 font-mono text-[10.5px] text-[var(--color-fg-dim)]">
                    from fleet.yaml · {project.services.length} service{project.services.length === 1 ? '' : 's'}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-4 font-mono text-[11px]">
                {/* A bar per service: the stack's health at a glance, before
                    reading a single word. */}
                <div className="flex items-center gap-1" title={`${project.running} of ${project.services.length} running`}>
                  {project.services.map((s) => {
                    const t = describeState(s)
                    return (
                      <span
                        key={s.id}
                        aria-hidden="true"
                        className={`h-3.5 w-1.5 rounded-full ${t.busy ? 'breathe' : ''}`}
                        style={{
                          background:
                            t.tone === 'ok'
                              ? 'var(--color-signal)'
                              : t.tone === 'down'
                                ? 'var(--color-down)'
                                : t.tone === 'warn'
                                  ? 'var(--color-warn)'
                                  : 'var(--color-line-2)',
                        }}
                      />
                    )
                  })}
                </div>
                <span
                  className={
                    allUp
                      ? 'text-[var(--color-signal)]'
                      : project.running === 0
                        ? 'text-[var(--color-fg-dim)]'
                        : 'text-[var(--color-warn)]'
                  }
                >
                  {project.running}/{project.services.length} running
                </span>
                <span className="text-[var(--color-fg-dim)]">{mb(project.ram)}</span>
              </div>
            </header>

            <div className="divide-y divide-[var(--color-line)]">

          {project.services.map((s, rowIndex) => {
            const url = s.domain || s.hostname ? `https://${s.domain ?? s.hostname}` : null
            const isRunning = s.current?.status === 'running' || s.current?.status === 'online'
            const isDeploying = busy === `deploy-${s.id}`
            const isRestarting = busy === `restart-${s.id}`
            const state = describeState(s)
            // An endpoint is only a link while something is answering on it.
            const reachable = isRunning && Boolean(url)
            const expanded = openReason === s.id

            return (
              <div
                key={s.id}
                className="rise-in flex flex-col justify-between gap-4 bg-[var(--color-ink-950)] p-5 transition-colors duration-200 hover:bg-[var(--color-ink-900)]"
                style={{ animationDelay: `${Math.min(rowIndex, 8) * 45}ms` }}
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

                    {/* Where the image comes from. "Image: manual" told the
                        reader nothing; the two real cases are a repository and
                        a build context uploaded from a machine. */}
                    <div className="mt-1.5 flex flex-wrap items-center gap-3 font-mono text-[11px] text-[var(--color-fg-dim)]">
                      {s.repoUrl ? (
                        <a
                          href={s.repoUrl.replace(/\.git$/, '')}
                          target="_blank"
                          rel="noreferrer"
                          className="truncate hover:text-[var(--color-fg-muted)]"
                          title="Open Git Repository"
                        >
                          {s.repoUrl.replace('https://github.com/', '')} ↗
                        </a>
                      ) : (
                        <span title="Built from a context uploaded by the CLI, not from a connected repository">
                          built from an uploaded context
                        </span>
                      )}
                      {state.when && <span title="When this deployment started">· {state.when}</span>}
                    </div>
                  </div>

                  {/* State — and, when it is not good news, why. */}
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    {isRunning ? (
                      <StatusPill status={s.current!.status} />
                    ) : (
                      <span
                        className={`inline-flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.1em] ${
                          state.tone === 'down'
                            ? 'text-[var(--color-down)]'
                            : state.tone === 'warn'
                              ? 'text-[var(--color-warn)]'
                              : 'text-[var(--color-fg-dim)]'
                        }`}
                      >
                        <Dot tone={state.tone} size={5} />
                        <span className={state.busy ? 'breathe' : undefined}>{state.label}</span>
                      </span>
                    )}
                    {state.detail && (
                      <button
                        onClick={() => setOpenReason(expanded ? null : s.id)}
                        aria-expanded={expanded}
                        className="press font-mono text-[10.5px] text-[var(--color-fg-dim)] underline underline-offset-2 hover:text-[var(--color-fg-muted)]"
                      >
                        {expanded ? 'hide reason' : 'why?'}
                      </button>
                    )}
                  </div>
                </div>

                {/* The reason, in the place a person is already looking. */}
                {state.detail && (
                  <div className="reveal -mt-1" data-open={expanded}>
                    <div>
                      <div className="rounded-[3px] border-l-2 border-[var(--color-down)] bg-[color-mix(in_oklab,var(--color-down)_6%,transparent)] px-3.5 py-3">
                        <p className="font-mono text-[11.5px] leading-relaxed text-[var(--color-fg-muted)]">
                          {summarise(state.detail).head}
                        </p>
                        {summarise(state.detail).rest && (
                          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all border-t border-[var(--color-line)] pt-2 font-mono text-[10.5px] leading-relaxed text-[var(--color-fg-dim)]">
                            {summarise(state.detail).rest}
                          </pre>
                        )}
                        <Link
                          to={`/logs?service=${s.id}`}
                          className="mt-2.5 inline-block font-mono text-[10.5px] text-[var(--color-fg-muted)] underline underline-offset-2 hover:text-[var(--color-fg)]"
                        >
                          open the container logs →
                        </Link>
                      </div>
                    </div>
                  </div>
                )}

                {/* ── Middle Row: Public URL & Node Placement ────── */}
                <div className="grid gap-3 rounded-[3px] border border-[var(--color-line)] bg-[var(--color-ink-900)] p-3.5 sm:grid-cols-[1fr_auto]">
                  <div className="min-w-0">
                    <div className="mono-label text-[9px] mb-1 text-[var(--color-fg-dim)]">
                      {url ? 'PUBLIC ENDPOINT' : 'REACHABLE AS'}
                    </div>
                    {url ? (
                      <div className="flex items-center gap-2.5">
                        {/* Presenting a dead URL in signal green, with a Copy
                            button, is the page telling you something works
                            when it does not. */}
                        <a
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          className={`truncate font-mono text-[12px] transition-colors hover:underline ${
                            reachable
                              ? 'text-[var(--color-signal)] hover:text-[#55ee9c]'
                              : 'text-[var(--color-fg-dim)] line-through decoration-[var(--color-line-2)]'
                          }`}
                          title={reachable ? 'Open live endpoint in browser' : 'Nothing is serving this address right now'}
                        >
                          {url} ↗
                        </a>
                        {!reachable && (
                          <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-[0.1em] text-[var(--color-warn)]">
                            not serving
                          </span>
                        )}
                        <button
                          onClick={() => {
                            void navigator.clipboard?.writeText(url)
                            setCopiedId(s.id)
                            setTimeout(() => setCopiedId(null), 2000)
                          }}
                          title="Copy URL"
                          className={`press shrink-0 rounded-[2px] border px-1.5 py-0.5 font-mono text-[9.5px] ${
                            copiedId === s.id
                              ? 'border-[var(--color-signal-dim)] text-[var(--color-signal)]'
                              : 'border-[var(--color-line-2)] text-[var(--color-fg-dim)] hover:border-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
                          }`}
                        >
                          {copiedId === s.id ? '✓ Copied' : 'Copy'}
                        </button>
                      </div>
                    ) : (
                      // An internal service has no public address by design.
                      // "No public domain attached" framed that as a lack.
                      <span className="font-mono text-[11px] text-[var(--color-fg-muted)]">
                        <span className="text-[var(--color-fg)]">{s.name}</span>
                        <span className="text-[var(--color-fg-dim)]"> — private to the fleet network</span>
                      </span>
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

                    {/* Only shown when it says something. A permanent
                        "REPLICAS 1" is a column of noise — and the scheduler
                        does not act on this number yet, so advertising it on
                        every row promises behaviour that does not exist. */}
                    {s.replicas > 1 && (
                      <div>
                        <span className="block mono-label text-[9px] text-[var(--color-fg-dim)]">REPLICAS</span>
                        <span>{s.replicas}</span>
                      </div>
                    )}

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
                      {isRunning && (
                        <button
                          onClick={() => void stop(s)}
                          disabled={busy !== null}
                          title="Stop and tear down running containers"
                          className="inline-flex items-center gap-1.5 rounded-[3px] border border-[var(--color-line-2)] bg-[var(--color-ink-900)] px-3 py-1 font-mono text-[11px] text-[var(--color-down)] transition-colors hover:border-[var(--color-down)] disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {busy === `stop-${s.id}` ? 'Stopping…' : '⏹ Stop'}
                        </button>
                      )}

                      <button
                        onClick={() => void restart(s)}
                        disabled={busy !== null || !isRunning}
                        // A disabled control with no explanation is
                        // indistinguishable from a broken one.
                        title={
                          !isRunning
                            ? 'Nothing is running to restart — use Deploy'
                            : 'Replace the container on its current node'
                        }
                        className="press inline-flex items-center gap-1.5 rounded-[3px] border border-[var(--color-line-2)] bg-[var(--color-ink-900)] px-3 py-1 font-mono text-[11px] text-[var(--color-fg-muted)] hover:border-[var(--color-fg-dim)] hover:text-[var(--color-fg)] disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {isRestarting ? <span className="breathe">Restarting…</span> : '⚡ Restart'}
                      </button>

                      <Button
                        variant={isRunning ? 'ghost' : 'primary'}
                        onClick={() => void deploy(s)}
                        disabled={busy !== null}
                        className={`press h-[30px] px-3.5 text-[11px] ${isDeploying ? 'shimmer' : ''}`}
                      >
                        {isDeploying ? <span className="breathe">Deploying…</span> : isRunning ? '🚀 Redeploy' : '🚀 Deploy'}
                      </Button>

                      {canEdit && (
                        <button
                          onClick={() => setConfirmDelete(s)}
                          disabled={busy !== null}
                          title="Permanently remove service from fleet"
                          className="inline-flex items-center justify-center rounded-[3px] border border-[var(--color-line-2)] p-1 px-2 font-mono text-[11px] text-[var(--color-fg-dim)] transition-colors hover:border-[var(--color-down)] hover:text-[var(--color-down)] disabled:opacity-40"
                        >
                          {busy === `delete-${s.id}` ? '…' : '🗑️'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
            </div>
          </section>
          )
          })}
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title={`Delete ${confirmDelete?.name ?? 'service'}`}
        body="This removes the service from the fleet. It cannot be undone from the dashboard."
        consequences={[
          'Its container is removed from the node it runs on',
          'Its deployment history and URL are released',
          'To stop it without deleting it, use Stop instead',
        ]}
        confirmPhrase={confirmDelete?.name}
        confirmLabel="Delete service"
        busy={busy === `delete-${confirmDelete?.id}`}
        onConfirm={() => { if (confirmDelete) void deleteService(confirmDelete) }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  )
}
