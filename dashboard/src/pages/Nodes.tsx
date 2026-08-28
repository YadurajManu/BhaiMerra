import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { api, type Node } from '../lib/api'
import { useAuth, usePoll } from '../lib/auth'
import { mb, since, pct, toneOf } from '../lib/format'
import { Button, ConfirmDialog, Dot, Empty, ErrorNote, Meter, Panel, StatusPill } from '../components/ui'

type FilterOption = 'ALL' | 'ONLINE' | 'OFFLINE' | 'CORDONED' | 'DARWIN' | 'LINUX' | 'WINDOWS'
type PlatformTab = 'unix' | 'windows' | 'cli'

function getOsIcon(os: string): { icon: string; name: string } {
  const lower = os.toLowerCase()
  if (lower.includes('darwin') || lower.includes('mac') || lower.includes('apple')) {
    return { icon: '🍏', name: 'macOS' }
  }
  if (lower.includes('win')) {
    return { icon: '🪟', name: 'Windows' }
  }
  if (lower.includes('linux')) {
    return { icon: '🐧', name: 'Linux' }
  }
  return { icon: '💻', name: os || 'Unix' }
}

export default function Nodes() {
  const { fleet } = useAuth()
  const id = fleet?.id
  const canManage = fleet?.role === 'owner' || fleet?.role === 'admin'

  const { data, error, loading } = usePoll(() => api<{ nodes: Node[] }>(`/fleets/${id}/nodes`), [id])
  const [pairing, setPairing] = useState<{ token: string; install_command: string; expires_at: string } | null>(null)
  const [activePlatformTab, setActivePlatformTab] = useState<PlatformTab>('unix')
  const [copiedCmd, setCopiedCmd] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<unknown>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<FilterOption>('ALL')
  const [confirmRemove, setConfirmRemove] = useState<Node | null>(null)

  const nodes = useMemo(() => data?.nodes ?? [], [data])
  const liveNodes = useMemo(() => nodes.filter((n) => n.live || n.status === 'online'), [nodes])

  // Cluster aggregate compute metrics
  const clusterMetrics = useMemo(() => {
    const totalNodes = nodes.length
    const onlineCount = liveNodes.length
    const totalCores = nodes.reduce((sum, n) => sum + (n.cpuCores || 0), 0)
    const totalRamMb = nodes.reduce((sum, n) => sum + (n.ramMb || 0), 0)
    const totalTunnels = nodes.filter((n) => n.telemetry?.meshConnected).length
    const totalWorkloads = nodes.reduce((sum, n) => sum + (n.telemetry?.containers?.length || 0), 0)
    return { totalNodes, onlineCount, totalCores, totalRamMb, totalTunnels, totalWorkloads }
  }, [nodes, liveNodes])

  // Filtered nodes
  const filteredNodes = useMemo(() => {
    return nodes.filter((n) => {
      // Status & Platform filters
      if (filter === 'ONLINE' && n.status !== 'online') return false
      if (filter === 'OFFLINE' && n.status !== 'offline') return false
      if (filter === 'CORDONED' && n.status !== 'cordoned') return false
      if (filter === 'DARWIN' && !n.os.toLowerCase().includes('darwin')) return false
      if (filter === 'LINUX' && !n.os.toLowerCase().includes('linux')) return false
      if (filter === 'WINDOWS' && !n.os.toLowerCase().includes('win')) return false

      // Search filter
      if (!search.trim()) return true
      const q = search.toLowerCase()
      return (
        n.name.toLowerCase().includes(q) ||
        n.os.toLowerCase().includes(q) ||
        n.arch.toLowerCase().includes(q) ||
        (n.advertiseAddr ?? '').toLowerCase().includes(q) ||
        (n.agentVersion ?? '').toLowerCase().includes(q) ||
        n.tags.some((t) => t.toLowerCase().includes(q)) ||
        (n.telemetry?.containers ?? []).some((c) => c.name.toLowerCase().includes(q))
      )
    })
  }, [nodes, filter, search])

  async function mintToken() {
    setBusy('pair')
    setActionError(null)
    try {
      setPairing(await api(`/fleets/${id}/nodes/pair-token`, { method: 'POST' }))
    } catch (err) {
      setActionError(err)
    } finally {
      setBusy(null)
    }
  }

  async function cordon(node: Node, cordoned: boolean) {
    setBusy(`cordon-${node.id}`)
    setActionError(null)
    setActionSuccess(null)
    try {
      await api(`/fleets/${id}/nodes/${node.id}/cordon`, { method: 'POST', body: { cordoned } })
      setActionSuccess(`Node ${node.name} ${cordoned ? 'cordoned' : 'uncordoned'}`)
      setTimeout(() => setActionSuccess(null), 3000)
    } catch (err) {
      setActionError(err)
    } finally {
      setBusy(null)
    }
  }

  /**
   * Remove a node. The API evicts its workloads first and reports what happened
   * to each one, so the success line says where things went rather than only
   * that the node is gone — a service that could not move is the one thing the
   * operator needs to hear about, and it is easy to miss on the Services page.
   */
  async function remove(node: Node) {
    setBusy(`remove-${node.id}`)
    setActionError(null)
    setActionSuccess(null)
    try {
      const res = await api<{
        evicted?: Array<{ service: string; action: string; toNodeName?: string; reason?: string }>
      }>(`/fleets/${id}/nodes/${node.id}`, { method: 'DELETE' })
      setConfirmRemove(null)

      const evicted = res.evicted ?? []
      const moved = evicted.filter((e) => e.action === 'moved')
      const held = evicted.filter((e) => e.action !== 'moved')
      const detail = [
        moved.length ? `${moved.length} service${moved.length === 1 ? '' : 's'} rescheduled` : null,
        held.length ? `${held.length} could not move: ${held.map((h) => h.service).join(', ')}` : null,
      ].filter(Boolean)

      setActionSuccess(
        `${node.name} removed and its credentials revoked` + (detail.length ? ` — ${detail.join('; ')}` : '')
      )
      // Held services are a standing problem, not a transient toast. Give the
      // operator time to read the names before it clears.
      setTimeout(() => setActionSuccess(null), held.length ? 12000 : 4000)
    } catch (err) {
      setActionError(err)
    } finally {
      setBusy(null)
    }
  }

  const copyInstallCommand = (cmd: string) => {
    void navigator.clipboard?.writeText(cmd)
    setCopiedCmd(true)
    setTimeout(() => setCopiedCmd(false), 2000)
  }

  if (error) return <ErrorNote error={error} />

  return (
    <div className="space-y-6">
      {/* ── Page Header ─────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-mono text-[22px] font-semibold tracking-[-0.02em]">Nodes</h1>
          <p className="mt-1 text-[13.5px] text-[var(--color-fg-muted)]">
            Every machine in <span className="font-medium text-[var(--color-fg)]">{fleet?.name}</span>. Capability is detected automatically, not declared.
          </p>
        </div>
        {canManage && (
          <Button
            variant="primary"
            onClick={mintToken}
            disabled={busy === 'pair'}
            className="h-[34px] px-4 font-mono text-[11.5px]"
          >
            {busy === 'pair' ? 'Generating Token…' : '+ Add a Machine'}
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

      {/* ── Cluster Compute KPI Cards ────────────────────────────── */}
      <div className="grid gap-px bg-[var(--color-line)] sm:grid-cols-2 lg:grid-cols-5">
        {[
          ['Total Machines', String(clusterMetrics.totalNodes), 'idle'],
          ['Online Nodes', `${clusterMetrics.onlineCount} / ${clusterMetrics.totalNodes}`, clusterMetrics.onlineCount > 0 ? 'ok' : 'down'],
          ['Cluster Cores', `${clusterMetrics.totalCores} Cores`, 'idle'],
          ['Cluster RAM', mb(clusterMetrics.totalRamMb), 'idle'],
          ['Active Tunnels', `${clusterMetrics.totalTunnels} Connected`, clusterMetrics.totalTunnels > 0 ? 'ok' : 'idle'],
        ].map(([label, value, tone]) => (
          <div key={label} className="bg-[var(--color-ink-950)] px-5 py-3.5">
            <div className="mono-label normal-case tracking-[0.08em]">{label}</div>
            <div className="mt-1.5 flex items-center gap-2">
              {tone !== 'idle' && <Dot tone={tone as 'ok' | 'down' | 'warn'} size={6} />}
              <span className="tabular font-mono text-[18px] font-semibold tracking-[-0.02em]">{value}</span>
            </div>
          </div>
        ))}
      </div>

      {/* ── Multi-Platform Pairing Modal / Drawer ────────────────── */}
      {pairing && (
        <Panel
          title="Pair a New Machine"
          right={
            <span className="font-mono text-[10.5px] text-[var(--color-warn)]">
              Token expires in {since(pairing.expires_at)}
            </span>
          }
          className="fade-up"
        >
          <div className="space-y-5 p-5">
            {/* Step Explanation Grid */}
            <div className="grid gap-px border border-[var(--color-line)] bg-[var(--color-line)] sm:grid-cols-3">
              {(
                [
                  ['01', 'Copy Command', 'Run the one-time command on the target laptop, server, or Pi.'],
                  ['02', 'Auto-Setup', 'Installer automatically verifies Docker engine and pairs the agent.'],
                  [
                    '03',
                    liveNodes.length ? 'Connected' : 'Handshake Waiting',
                    liveNodes.length
                      ? `✓ ${liveNodes.length} live node(s) currently heartbeating.`
                      : 'Listening for agent heartbeat over WebSocket reverse tunnel…',
                  ],
                ] as const
              ).map(([step, title, detail]) => (
                <div key={step} className="bg-[var(--color-ink-950)] px-4 py-3">
                  <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-fg-dim)]">
                    <span className={title.includes('Connected') ? 'text-[var(--color-signal)] font-bold' : ''}>{step}</span>
                    <span className={title.includes('Connected') ? 'text-[var(--color-signal)] font-bold' : ''}>{title}</span>
                  </div>
                  <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">{detail}</p>
                </div>
              ))}
            </div>

            {/* Platform Selector Tabs */}
            <div>
              <div className="flex items-center justify-between border-b border-[var(--color-line)] pb-2">
                <span className="mono-label">Target Platform</span>
                <div className="flex items-center gap-1 font-mono text-[11px]">
                  <button
                    onClick={() => setActivePlatformTab('unix')}
                    className={`rounded-[3px] px-2.5 py-1 transition-colors ${
                      activePlatformTab === 'unix'
                        ? 'bg-[var(--color-ink-800)] font-medium text-[var(--color-fg)]'
                        : 'text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]'
                    }`}
                  >
                    🍏 macOS / 🐧 Linux
                  </button>
                  <button
                    onClick={() => setActivePlatformTab('windows')}
                    className={`rounded-[3px] px-2.5 py-1 transition-colors ${
                      activePlatformTab === 'windows'
                        ? 'bg-[var(--color-ink-800)] font-medium text-[var(--color-fg)]'
                        : 'text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]'
                    }`}
                  >
                    🪟 Windows (Git Bash)
                  </button>
                  <button
                    onClick={() => setActivePlatformTab('cli')}
                    className={`rounded-[3px] px-2.5 py-1 transition-colors ${
                      activePlatformTab === 'cli'
                        ? 'bg-[var(--color-ink-800)] font-medium text-[var(--color-fg)]'
                        : 'text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]'
                    }`}
                  >
                    📦 Fleet CLI / NPM
                  </button>
                </div>
              </div>

              {/* Install Command Display */}
              <div className="mt-3">
                <div className="relative flex items-center justify-between rounded-[3px] border border-[var(--color-line)] bg-[#07080a] p-3.5 font-mono text-[12px] text-[var(--color-signal)]">
                  <span className="truncate pr-4 select-all">
                    {activePlatformTab === 'cli'
                      ? 'npx @yadurajfleetos/cli nodes pair'
                      : pairing.install_command}
                  </span>
                  <button
                    onClick={() =>
                      copyInstallCommand(
                        activePlatformTab === 'cli'
                          ? 'npx @yadurajfleetos/cli nodes pair'
                          : pairing.install_command
                      )
                    }
                    className="shrink-0 rounded-[3px] border border-[var(--color-line-2)] bg-[var(--color-ink-850)] px-2.5 py-1 font-mono text-[11px] text-[var(--color-fg-muted)] transition-colors hover:border-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
                  >
                    {copiedCmd ? '✓ Copied' : '📋 Copy'}
                  </button>
                </div>

                {activePlatformTab === 'windows' && (
                  <p className="mt-2 font-mono text-[11px] text-[var(--color-fg-dim)]">
                    Tip: Run in Git Bash or WSL. If Docker Desktop is missing, the installer will automatically download and set it up via winget.
                  </p>
                )}
              </div>
            </div>

            {/* Radar status footer */}
            <div className="flex items-center justify-between border-t border-[var(--color-line)] pt-4">
              <div className="flex items-center gap-2.5 font-mono text-[11px]">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-signal)] opacity-75" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[var(--color-signal)]" />
                </span>
                <span className="text-[var(--color-fg-muted)]">
                  Listening for agent report… Token valid until {new Date(pairing.expires_at).toLocaleTimeString()}
                </span>
              </div>
              <Button onClick={() => setPairing(null)} className="h-[30px] text-[11px]">
                {liveNodes.length > 0 ? 'Done' : 'Dismiss'}
              </Button>
            </div>
          </div>
        </Panel>
      )}

      {/* ── Search & Platform Filter Toolbar ─────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-line)] pb-3">
        {/* Filter Pills */}
        <div className="flex flex-wrap items-center gap-1 font-mono text-[11px]">
          {(
            [
              ['ALL', `All (${nodes.length})`],
              ['ONLINE', `Online (${clusterMetrics.onlineCount})`],
              ['OFFLINE', `Offline (${clusterMetrics.totalNodes - clusterMetrics.onlineCount})`],
              ['DARWIN', `🍏 macOS`],
              ['LINUX', `🐧 Linux`],
              ['WINDOWS', `🪟 Windows`],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`rounded-[3px] px-2.5 py-1 transition-colors ${
                filter === key
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
            placeholder="Search hostname, OS, IP, containers…"
            className="h-[30px] w-[240px] rounded-[3px] border border-[var(--color-line)] bg-[var(--color-ink-900)] pl-7 pr-7 font-mono text-[11.5px] text-[var(--color-fg)] outline-none transition-all placeholder:text-[var(--color-fg-dim)] focus:w-[300px] focus:border-[var(--color-line-2)]"
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

      {/* ── Nodes Cards Grid ─────────────────────────────────────── */}
      {!loading && !nodes.length ? (
        <Empty
          title="No machines paired yet"
          hint="Pair a laptop, desktop, or cloud VM you own to start scheduling container workloads onto your hardware."
          action={
            canManage ? (
              <Button variant="primary" onClick={mintToken}>
                Add your first machine
              </Button>
            ) : undefined
          }
        />
      ) : filteredNodes.length === 0 ? (
        <div className="py-12 text-center font-mono text-[12px] text-[var(--color-fg-dim)]">
          No machines match your filter "{search || filter}".
          <button
            onClick={() => {
              setSearch('')
              setFilter('ALL')
            }}
            className="ml-2 text-[var(--color-signal)] underline hover:text-[#55ee9c]"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {filteredNodes.map((n) => {
            const isOnline = n.status === 'online'
            const osInfo = getOsIcon(n.os)
            const ramUsed = n.telemetry?.ramUsedMb ?? 0
            const ramRatio = n.ramMb > 0 ? ramUsed / n.ramMb : 0
            const isCordoning = busy === `cordon-${n.id}`
            const isRemoving = busy === `remove-${n.id}`
            const hasTunnel = n.telemetry?.meshConnected ?? false

            return (
              <div
                key={n.id}
                className="panel flex flex-col justify-between rounded-[4px] bg-[var(--color-ink-950)] p-5 transition-all duration-200 hover:border-[var(--color-line-2)]"
                style={
                  !isOnline
                    ? { background: 'color-mix(in oklab, var(--color-down) 3%, var(--color-ink-950))' }
                    : undefined
                }
              >
                {/* ── Node Header Row ─────────────────────────────── */}
                <div>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[14px]" title={osInfo.name}>
                          {osInfo.icon}
                        </span>
                        <span className="font-mono text-[15px] font-semibold text-[var(--color-fg)]">
                          {n.name}
                        </span>

                        {/* Reverse Tunnel Status Badge */}
                        {isOnline && (
                          <span
                            className={`inline-flex items-center gap-1 rounded-[3px] border px-2 py-0.5 font-mono text-[10px] ${
                              hasTunnel
                                ? 'border-[var(--color-signal-dim)] bg-[color-mix(in_oklab,var(--color-signal)_10%,transparent)] text-[var(--color-signal)]'
                                : 'border-[var(--color-line-2)] bg-[var(--color-ink-850)] text-[var(--color-fg-dim)]'
                            }`}
                          >
                            <span className={`h-1.5 w-1.5 rounded-full ${hasTunnel ? 'bg-[var(--color-signal)]' : 'bg-[var(--color-fg-dim)]'}`} />
                            {hasTunnel ? 'Tunnel Active' : 'Direct'}
                          </span>
                        )}

                        {/* Reliability Tier */}
                        <span className="rounded-[3px] border border-[var(--color-line-2)] bg-[var(--color-ink-850)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-fg-muted)]">
                          {n.reliabilityTier}
                        </span>

                        {/* GPU Badge */}
                        {n.hasGpu && (
                          <span className="rounded-[3px] border border-[var(--color-signal-dim)] bg-[color-mix(in_oklab,var(--color-signal)_10%,transparent)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-signal)]">
                            ⚡ GPU
                          </span>
                        )}
                      </div>

                      {/* Specs Subtitle */}
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[10.5px] text-[var(--color-fg-dim)]">
                        <span>{osInfo.name} ({n.arch})</span>
                        <span>·</span>
                        <span>{n.cpuCores} cores</span>
                        <span>·</span>
                        <span>{mb(n.ramMb)} physical RAM</span>
                      </div>
                    </div>

                    {/* Status Pill */}
                    <div className="shrink-0">
                      <StatusPill status={n.status} />
                    </div>
                  </div>

                  {/* ── Telemetry Gauges ──────────────────────────── */}
                  <div className="mt-4 rounded-[3px] border border-[var(--color-line)] bg-[var(--color-ink-900)] p-3.5">
                    {n.telemetry ? (
                      <div className="space-y-2.5">
                        <Meter
                          value={n.telemetry.cpuPct}
                          max={100}
                          label={`CPU ${Math.round(n.telemetry.cpuPct)}%`}
                          warnAt={0.8}
                        />
                        <Meter
                          value={ramUsed}
                          max={n.ramMb}
                          label={`RAM ${mb(ramUsed)} / ${mb(n.ramMb)}`}
                          warnAt={0.85}
                        />
                        {n.diskMb > 0 && (
                          <Meter
                            value={n.telemetry.diskUsedMb || 0}
                            max={n.diskMb}
                            label={`Disk ${mb(n.telemetry.diskUsedMb || 0)} / ${mb(n.diskMb)}`}
                            warnAt={0.9}
                          />
                        )}
                      </div>
                    ) : (
                      <p className="font-mono text-[11px] text-[var(--color-fg-dim)]">
                        No live telemetry — node last heartbeated {since(n.lastHeartbeatAt)}.
                      </p>
                    )}
                  </div>

                  {/* ── Workloads Section ─────────────────────────── */}
                  <div className="mt-3.5">
                    <div className="mono-label text-[9px] mb-1.5 text-[var(--color-fg-dim)]">
                      ACTIVE WORKLOADS ({(n.telemetry?.containers ?? []).length})
                    </div>
                    {(n.telemetry?.containers ?? []).length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {n.telemetry?.containers.map((c) => (
                          <Link
                            key={c.name}
                            to={`/logs?service=${c.name}`}
                            className="inline-flex items-center gap-1.5 rounded-[3px] border border-[var(--color-line-2)] bg-[var(--color-ink-900)] px-2.5 py-1 font-mono text-[10.5px] text-[var(--color-fg-muted)] transition-colors hover:border-[var(--color-signal-dim)] hover:text-[var(--color-fg)]"
                            title={`Inspect live logs for ${c.name}`}
                          >
                            <Dot tone={c.state === 'running' ? 'ok' : 'warn'} size={4} />
                            <span>{c.name}</span>
                            <span className="text-[9px] text-[var(--color-fg-dim)]">↗ logs</span>
                          </Link>
                        ))}
                      </div>
                    ) : (
                      <span className="font-mono text-[10.5px] text-[var(--color-fg-dim)]">
                        No containers allocated on this node.
                      </span>
                    )}
                  </div>

                  {/* ── Runtime Diagnostics Grid ──────────────────── */}
                  <div className="mt-4 grid grid-cols-2 gap-2.5 border-t border-[var(--color-line)] pt-3.5 font-mono text-[10.5px]">
                    <div>
                      <span className="block mono-label text-[9px] text-[var(--color-fg-dim)]">DOCKER ENGINE</span>
                      <span className="text-[var(--color-fg)]">
                        {n.telemetry?.runtime?.dockerAvailable ? (
                          <span className="text-[var(--color-signal)]">
                            ✓ {n.telemetry.runtime.dockerVersion || 'v27+'}
                          </span>
                        ) : (
                          <span className="text-[var(--color-down)]">✖ Unavailable</span>
                        )}
                      </span>
                    </div>

                    <div>
                      <span className="block mono-label text-[9px] text-[var(--color-fg-dim)]">REGISTRY ACCESS</span>
                      <span className="text-[var(--color-fg-muted)]">
                        {n.telemetry?.runtime?.registryStatus === 'ok' ? (
                          <span className="text-[var(--color-signal)]">✓ OK</span>
                        ) : (
                          <span>{n.telemetry?.runtime?.registryStatus || 'checked on pull'}</span>
                        )}
                      </span>
                    </div>

                    <div>
                      <span className="block mono-label text-[9px] text-[var(--color-fg-dim)]">IP ADDRESS</span>
                      <span className="truncate text-[var(--color-fg-muted)]">
                        {n.advertiseAddr || 'private network'}
                      </span>
                    </div>

                    <div>
                      <span className="block mono-label text-[9px] text-[var(--color-fg-dim)]">HEARTBEAT</span>
                      <span className={isOnline ? 'text-[var(--color-fg-muted)]' : 'text-[var(--color-down)]'}>
                        {since(n.lastHeartbeatAt)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* ── Action Bar Footer ──────────────────────────── */}
                <div className="mt-4 flex items-center justify-between border-t border-[var(--color-line)] pt-3">
                  <span className="font-mono text-[10px] text-[var(--color-fg-dim)]">
                    Agent {n.agentVersion ? `v${n.agentVersion}` : 'v0.1.0'}
                  </span>

                  {canManage && (
                    <div className="flex items-center gap-2">
                      <Button
                        onClick={() => void cordon(n, n.status !== 'cordoned')}
                        disabled={busy !== null}
                        className="h-[28px] px-2.5 text-[10.5px]"
                        title={
                          n.status === 'cordoned'
                            ? 'Uncordon: resume scheduling new containers here'
                            : 'Cordon: prevent new containers from landing on this node'
                        }
                      >
                        {isCordoning ? 'Saving…' : n.status === 'cordoned' ? 'Uncordon' : 'Cordon'}
                      </Button>

                      {fleet?.role === 'owner' && (
                        <Button
                          variant="danger"
                          onClick={() => setConfirmRemove(n)}
                          disabled={busy !== null}
                          className="h-[28px] px-2.5 text-[10.5px]"
                          title="Revoke pairing credentials and remove from cluster"
                        >
                          {isRemoving ? 'Removing…' : 'Remove'}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <ConfirmDialog
        open={confirmRemove !== null}
        title={`Remove ${confirmRemove?.name ?? 'node'}`}
        body="This takes the machine out of the fleet. It can be paired again later, but with new credentials."
        consequences={[
          'Its agent credentials are revoked and its reverse tunnel is closed',
          'Flexible and preferred services are moved to other nodes',
          'Pinned services stay put and will have nowhere to run',
          `To clean up the machine itself, run "fleet unpair" on it`,
        ]}
        confirmPhrase={confirmRemove?.name}
        confirmLabel="Remove node"
        busy={busy === `remove-${confirmRemove?.id}`}
        onConfirm={() => { if (confirmRemove) void remove(confirmRemove) }}
        onCancel={() => setConfirmRemove(null)}
      />
    </div>
  )
}
