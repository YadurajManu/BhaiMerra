import { useState } from 'react'
import { api, type Node } from '../lib/api'
import { useAuth, usePoll } from '../lib/auth'
import { mb, since } from '../lib/format'
import { Button, Copyable, Dot, Empty, ErrorNote, GridFiller, Meter, Panel, StatusPill } from '../components/ui'

export default function Nodes() {
  const { fleet } = useAuth()
  const id = fleet?.id
  const canManage = fleet?.role === 'owner' || fleet?.role === 'admin'

  const { data, error, loading } = usePoll(() => api<{ nodes: Node[] }>(`/fleets/${id}/nodes`), [id])
  const [pairing, setPairing] = useState<{ token: string; install_command: string; expires_at: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<unknown>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

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
    setBusy(node.id)
    setActionError(null)
    try {
      await api(`/fleets/${id}/nodes/${node.id}/cordon`, { method: 'POST', body: { cordoned } })
    } catch (err) {
      setActionError(err)
    } finally {
      setBusy(null)
    }
  }

  async function remove(node: Node) {
    // Irreversible and it revokes a credential, so it asks.
    const typed = window.prompt(
      `Removing "${node.name}" revokes its agent credentials and takes it out of the fleet.\n` +
        `Anything pinned to it will have nowhere to run.\n\nType the node name to confirm:`
    )
    if (typed !== node.name) return
    setBusy(node.id)
    try {
      await api(`/fleets/${id}/nodes/${node.id}`, { method: 'DELETE' })
    } catch (err) {
      setActionError(err)
    } finally {
      setBusy(null)
    }
  }

  if (error) return <ErrorNote error={error} />
  const nodes = data?.nodes ?? []
  const liveNodes = nodes.filter((n) => n.live)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.03em]">Nodes</h1>
          <p className="mt-1 text-[13.5px] text-[var(--color-fg-muted)]">
            Every machine in {fleet?.name}. Capability is detected, not declared.
          </p>
        </div>
        {canManage && (
          <Button variant="primary" onClick={mintToken} disabled={busy === 'pair'}>
            {busy === 'pair' ? 'minting…' : 'Add a node'}
          </Button>
        )}
      </div>

      <ErrorNote error={actionError} />

      {pairing && (
        <Panel title={liveNodes.length ? 'node connected' : 'pair a machine'} className="fade-up">
          <div className="space-y-5 p-5">
            <div className="grid gap-px border border-[var(--color-line)] bg-[var(--color-line)] sm:grid-cols-3">
              {[
                ['01', 'copy', 'Run this one-time command on the machine you are adding.'],
                ['02', 'pair', 'Its token is single-use and expires shortly.'],
                [
                  '03',
                  liveNodes.length ? 'connected' : 'waiting',
                  liveNodes.length
                    ? `${liveNodes.length} live node${liveNodes.length === 1 ? '' : 's'} reporting to this fleet.`
                    : 'This page updates automatically when the agent reports in.',
                ],
              ].map(([step, title, detail]) => (
                <div key={step} className="bg-[var(--color-ink-950)] px-4 py-3">
                  <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-fg-dim)]">
                    <span className={title === 'connected' ? 'text-[var(--color-signal)]' : undefined}>{step}</span>
                    <span className={title === 'connected' ? 'text-[var(--color-signal)]' : undefined}>{title}</span>
                  </div>
                  <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">{detail}</p>
                </div>
              ))}
            </div>

            <div>
              <div className="mono-label">run this on the machine you want to add (curl or npm)</div>
              <div className="mt-2 overflow-x-auto rounded-[3px] border border-[var(--color-line)] bg-[var(--color-ink-950)] px-4 py-3">
                <Copyable text={pairing.install_command} className="text-[var(--color-signal)]" />
              </div>
              <div className="mt-3 flex items-center gap-2 font-mono text-[11px] text-[var(--color-fg-dim)]">
                <span>Or run CLI:</span>
                <code className="rounded bg-[var(--color-bg-subtle)] px-2 py-0.5 text-[var(--color-fg)]">npx @yadurajfleetos/cli nodes pair</code>
              </div>
            </div>
            <p className="font-mono text-[10.5px] text-[var(--color-fg-dim)]">
              Single-use, expires {since(pairing.expires_at)}. Re-running the installer on an already-paired machine makes no changes; use <code>--reset</code> only to deliberately pair it again.
            </p>
            <div className="flex items-center gap-3">
              {liveNodes.length > 0 && <span className="font-mono text-[10.5px] text-[var(--color-signal)]">● live telemetry received</span>}
              <Button className="ml-auto" onClick={() => setPairing(null)}>{liveNodes.length ? 'Continue' : 'Done'}</Button>
            </div>
          </div>
        </Panel>
      )}

      {!loading && !nodes.length ? (
        <Empty
          title="Pair your first node"
          hint="Open Add a node, run the generated one-time command on a machine you own, then watch it appear here automatically. The agent is a single static binary with no runtime dependency."
          action={
            canManage ? <Button variant="primary" onClick={mintToken}>Add your first node</Button> : undefined
          }
        />
      ) : (
        <div className="grid gap-px bg-[var(--color-line)] lg:grid-cols-2">
          {nodes.map((n) => {
            const used = n.telemetry?.ramUsedMb ?? 0
            const open = expanded === n.id
            return (
              <div key={n.id} className="bg-[var(--color-ink-950)] p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Dot tone={n.status === 'online' ? 'ok' : n.status === 'offline' ? 'down' : 'warn'} size={7} />
                      <span className="truncate font-mono text-[14px]">{n.name}</span>
                    </div>
                    <div className="mt-1.5 pl-[15px] font-mono text-[10px] tracking-[0.06em] text-[var(--color-fg-dim)]">
                      {n.arch} · {n.cpuCores} cores · {mb(n.ramMb)} · {n.reliabilityTier}
                      {n.hasGpu && ' · gpu'}
                    </div>
                  </div>
                  <StatusPill status={n.status} />
                </div>

                {n.telemetry ? (
                  <div className="mt-4 space-y-2">
                    <Meter value={n.telemetry.cpuPct} max={100} label={`cpu ${Math.round(n.telemetry.cpuPct)}%`} />
                    <Meter value={used} max={n.ramMb} label={`${mb(used)} / ${mb(n.ramMb)}`} />
                  </div>
                ) : (
                  <p className="mt-4 font-mono text-[10.5px] text-[var(--color-fg-dim)]">
                    no telemetry — last seen {since(n.lastHeartbeatAt)}
                  </p>
                )}

                <div className="mt-4 flex flex-wrap items-center gap-1.5">
                  {(n.telemetry?.containers ?? []).map((c) => (
                    <span
                      key={c.name}
                      className="inline-flex items-center gap-1.5 border border-[var(--color-line-2)] bg-[var(--color-ink-850)] px-2 py-1 font-mono text-[10px] text-[var(--color-fg-muted)]"
                    >
                      <Dot tone={c.state === 'running' ? 'ok' : 'warn'} size={4} />
                      {c.name}
                    </span>
                  ))}
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-dashed border-[var(--color-line)] pt-4">
                  <button
                    onClick={() => setExpanded(open ? null : n.id)}
                    className="font-mono text-[10.5px] text-[var(--color-fg-dim)] transition-colors hover:text-[var(--color-fg-muted)]"
                  >
                    {open ? 'hide details' : 'details'}
                  </button>
                  <span className="ml-auto flex gap-2">
                    {canManage && (
                      <>
                        <Button
                          onClick={() => void cordon(n, n.status !== 'cordoned')}
                          disabled={busy === n.id}
                          title={
                            n.status === 'cordoned'
                              ? 'Allow scheduling here again'
                              : 'Stop scheduling new work here; running services stay put'
                          }
                        >
                          {n.status === 'cordoned' ? 'uncordon' : 'cordon'}
                        </Button>
                        {fleet?.role === 'owner' && (
                          <Button variant="danger" onClick={() => void remove(n)} disabled={busy === n.id}>
                            remove
                          </Button>
                        )}
                      </>
                    )}
                  </span>
                </div>

                {open && (
                  <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 border-t border-[var(--color-line)] pt-4 font-mono text-[10.5px]">
                    {[
                      ['node id', n.id],
                      ['os', n.os],
                      ['disk', mb(n.diskMb)],
                      ['agent', n.agentVersion ?? '—'],
                      ['address', n.advertiseAddr ?? 'not reported'],
                      ['last heartbeat', since(n.lastHeartbeatAt)],
                      ['mesh', n.telemetry?.meshConnected ? 'connected' : 'not connected'],
                      ['tags', n.tags.length ? n.tags.join(', ') : '—'],
                    ].map(([k, v]) => (
                      <div key={k} className="min-w-0">
                        <dt className="text-[var(--color-fg-dim)]">{k}</dt>
                        <dd className="truncate text-[var(--color-fg-muted)]">{v}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            )
          })}
          <GridFiller count={nodes.length} />
        </div>
      )}
    </div>
  )
}
