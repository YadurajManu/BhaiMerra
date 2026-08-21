import { useEffect, useMemo, useState } from 'react'
import { api, type AuditEntry } from '../lib/api'
import { useAuth, usePoll } from '../lib/auth'
import { since } from '../lib/format'
import { Button, Copyable, ErrorNote, Field, Panel } from '../components/ui'

type GitHubStatus = {
  configured: boolean
  webhookBase: string
  clientId?: string | null
  error?: string
  installations?: Array<{ id: number; account: string; type: string }>
}

type GitHubRepo = { fullName: string; cloneUrl: string; private: boolean; defaultBranch: string; updatedAt: string }
type ConnectedRepo = {
  id: string; account: string; fullName: string; cloneUrl: string; defaultBranch: string; branch: string
  manifestPath: string; isPrivate: boolean; services: string[]; createdAt: string
}

function GitHubWorkspace({ fleet }: { fleet: NonNullable<ReturnType<typeof useAuth>['fleet']> }) {
  const [installationId, setInstallationId] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<GitHubRepo | null>(null)
  const [branch, setBranch] = useState('')
  const [manifestPath, setManifestPath] = useState('fleet.yaml')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<unknown>(null)
  const [revision, setRevision] = useState(0)

  const status = usePoll(() => api<GitHubStatus>(`/fleets/${fleet.id}/github/status`), [fleet.id], 30_000)
  const activeInstallation = installationId ?? status.data?.installations?.[0]?.id ?? null
  const catalog = usePoll(
    () => activeInstallation ? api<{ repos: GitHubRepo[] }>(`/fleets/${fleet.id}/github/catalog?installation=${activeInstallation}`) : Promise.resolve({ repos: [] }),
    [fleet.id, activeInstallation],
    30_000
  )
  const connected = usePoll(
    () => api<{ repositories: ConnectedRepo[] }>(`/fleets/${fleet.id}/github/repositories`),
    [fleet.id, revision],
    10_000
  )

  useEffect(() => {
    if (selected) setBranch(selected.defaultBranch)
  }, [selected])

  const visibleRepos = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return (catalog.data?.repos ?? []).filter((repo) => !needle || repo.fullName.toLowerCase().includes(needle))
  }, [catalog.data?.repos, search])

  async function connect() {
    if (!selected || !activeInstallation) return
    setBusy(true); setActionError(null)
    try {
      await api(`/fleets/${fleet.id}/github/repositories`, {
        method: 'POST',
        body: { installationId: activeInstallation, fullName: selected.fullName, branch, manifestPath },
      })
      setRevision((value) => value + 1)
      setSelected(null)
    } catch (err) { setActionError(err) } finally { setBusy(false) }
  }

  async function disconnect(repository: ConnectedRepo) {
    setBusy(true); setActionError(null)
    try {
      await api(`/fleets/${fleet.id}/github/repositories/${repository.id}`, { method: 'DELETE' })
      setRevision((value) => value + 1)
    } catch (err) { setActionError(err) } finally { setBusy(false) }
  }

  const webhookUrl = status.data ? `${status.data.webhookBase}/webhooks/git/${fleet.id}` : null
  const installations = status.data?.installations ?? []

  return (
    <Panel title="GitHub workspace" right={<span className="normal-case">accounts · repositories · deploy policy</span>}>
      <div className="p-5">
        <ErrorNote error={status.error ?? actionError} />

        {!status.data?.configured ? (
          <div className="border-l-2 border-[var(--color-warn)] bg-[color-mix(in_oklab,var(--color-warn)_5%,transparent)] p-4">
            <p className="font-mono text-[12px] text-[var(--color-warn)]">GitHub App required to browse and connect repositories</p>
            <p className="mt-2 max-w-[78ch] text-[12.5px] leading-relaxed text-[var(--color-fg-muted)]">
              Configure the control plane with a GitHub App private key, then install that App on only the accounts and repositories Fleet may read. The App needs Contents: read-only and Repository webhooks: read &amp; write. Fleet never stores a personal access token.
            </p>
          </div>
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="border border-[var(--color-line)] p-3.5">
                <p className="mono-label">GitHub App</p>
                <p className="mt-2 font-mono text-[12px] text-[var(--color-signal)]">connected</p>
                <p className="mt-1 text-[11.5px] text-[var(--color-fg-dim)]">short-lived installation tokens</p>
              </div>
              <div className="border border-[var(--color-line)] p-3.5">
                <p className="mono-label">accounts available</p>
                <p className="mt-2 font-mono text-[12px] text-[var(--color-fg)]">{installations.length}</p>
                <p className="mt-1 text-[11.5px] text-[var(--color-fg-dim)]">only App installations are listed</p>
              </div>
              <div className="border border-[var(--color-line)] p-3.5">
                <p className="mono-label">connected to this fleet</p>
                <p className="mt-2 font-mono text-[12px] text-[var(--color-fg)]">{connected.data?.repositories.length ?? 0}</p>
                <p className="mt-1 text-[11.5px] text-[var(--color-fg-dim)]">each has an explicit branch policy</p>
              </div>
            </div>

            <div className="mt-6 border-t border-[var(--color-line)] pt-5">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="font-mono text-[11.5px] text-[var(--color-fg)]">1. Choose a GitHub account</p>
                  <p className="mt-1 text-[12px] text-[var(--color-fg-dim)]">Fleet can only see repositories the App was installed on.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {installations.map((installation) => (
                    <Button
                      key={installation.id}
                      onClick={() => { setInstallationId(installation.id); setSelected(null) }}
                      variant={activeInstallation === installation.id ? 'primary' : 'ghost'}
                    >
                      {installation.account} <span className="opacity-65">{installation.type === 'Organization' ? 'org' : 'user'}</span>
                    </Button>
                  ))}
                </div>
              </div>

              {!installations.length ? (
                <p className="mt-4 text-[12.5px] text-[var(--color-fg-muted)]">The App is configured but not installed on a GitHub account yet.</p>
              ) : (
                <>
                  <div className="mt-5 flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <p className="font-mono text-[11.5px] text-[var(--color-fg)]">2. Choose a repository</p>
                      <p className="mt-1 text-[12px] text-[var(--color-fg-dim)]">A connected repository can create its services from its own fleet.yaml on the first push.</p>
                    </div>
                    <label className="block">
                      <span className="mono-label">filter repositories</span>
                      <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="owner/repository" className="mt-1.5 w-56 border border-[var(--color-line)] bg-[var(--color-ink-950)] px-3 py-2 font-mono text-[11.5px] outline-none focus:border-[var(--color-line-2)]" />
                    </label>
                  </div>
                  <div className="mt-3 max-h-64 divide-y divide-[var(--color-line)] overflow-y-auto border border-[var(--color-line)]">
                    {catalog.loading ? <p className="p-4 font-mono text-[11px] text-[var(--color-fg-dim)]">loading repositories…</p> : visibleRepos.map((repo) => {
                      const alreadyConnected = connected.data?.repositories.some((entry) => entry.fullName === repo.fullName)
                      return (
                        <button key={repo.fullName} onClick={() => setSelected(repo)} className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--color-ink-800)] ${selected?.fullName === repo.fullName ? 'bg-[var(--color-ink-800)]' : ''}`}>
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${repo.private ? 'bg-[var(--color-warn)]' : 'bg-[var(--color-signal)]'}`} />
                          <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{repo.fullName}</span>
                          <span className="font-mono text-[10px] text-[var(--color-fg-dim)]">{repo.private ? 'private' : 'public'} · {repo.defaultBranch}</span>
                          {alreadyConnected && <span className="font-mono text-[10px] text-[var(--color-signal)]">connected</span>}
                        </button>
                      )
                    })}
                    {!catalog.loading && !visibleRepos.length && <p className="p-4 text-[12px] text-[var(--color-fg-dim)]">No repositories match this filter.</p>}
                  </div>
                </>
              )}
            </div>

            {selected && (
              <div className="mt-5 border border-[var(--color-line-2)] bg-[var(--color-ink-900)] p-4 fade-up">
                <div className="flex flex-wrap items-baseline justify-between gap-3"><p className="font-mono text-[12px] text-[var(--color-fg)]">3. Set deploy policy for {selected.fullName}</p><span className="font-mono text-[10px] text-[var(--color-fg-dim)]">{selected.private ? 'private — App token required' : 'public repository'}</span></div>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <Field label="watch branch" value={branch} onChange={(event) => setBranch(event.target.value)} hint="Only pushes to this branch trigger Fleet." />
                  <Field label="manifest path" value={manifestPath} onChange={(event) => setManifestPath(event.target.value)} hint="Relative path, normally fleet.yaml." />
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-3"><Button variant="primary" onClick={() => void connect()} disabled={busy || !branch.trim() || !manifestPath.trim()}>{busy ? 'connecting…' : 'Connect repository'}</Button><Button onClick={() => setSelected(null)} disabled={busy}>Cancel</Button><span className="text-[11.5px] text-[var(--color-fg-dim)]">Fleet verifies this repo belongs to the selected App installation before saving.</span></div>
              </div>
            )}
          </>
        )}

        <div className="mt-6 border-t border-[var(--color-line)] pt-5">
          <div className="flex flex-wrap items-baseline justify-between gap-3"><div><p className="font-mono text-[11.5px] text-[var(--color-fg)]">Connected deployment repositories</p><p className="mt-1 text-[12px] text-[var(--color-fg-dim)]">Disconnecting stops future push-triggered deploys; it never deletes a running service.</p></div></div>
          <div className="mt-3 divide-y divide-[var(--color-line)] border border-[var(--color-line)]">
            {(connected.data?.repositories ?? []).map((repo) => (
              <div key={repo.id} className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
                <div className="min-w-[220px] flex-1"><p className="font-mono text-[12px] text-[var(--color-fg)]">{repo.fullName}</p><p className="mt-1 font-mono text-[10px] text-[var(--color-fg-dim)]">{repo.isPrivate ? 'private' : 'public'} · {repo.account}</p></div>
                <div className="font-mono text-[10.5px] text-[var(--color-fg-muted)]">branch {repo.branch}</div>
                <div className="font-mono text-[10.5px] text-[var(--color-fg-muted)]">{repo.manifestPath}</div>
                <div className="font-mono text-[10.5px] text-[var(--color-fg-dim)]">{repo.services.length ? repo.services.join(', ') : 'services appear after first push'}</div>
                <Button variant="danger" onClick={() => void disconnect(repo)} disabled={busy}>Disconnect</Button>
              </div>
            ))}
            {!connected.loading && !(connected.data?.repositories.length) && <p className="px-4 py-6 text-center text-[12px] text-[var(--color-fg-dim)]">No repositories connected to this fleet.</p>}
          </div>
        </div>

        {webhookUrl && <div className="mt-6 border-t border-[var(--color-line)] pt-5"><p className="font-mono text-[11.5px] text-[var(--color-fg)]">Webhook delivery</p><div className="mt-2"><Copyable text={webhookUrl} /></div><p className="mt-2 text-[12px] leading-relaxed text-[var(--color-fg-dim)]">GitHub repository Settings → Webhooks → Add webhook. Use JSON, “Just the push event”, and the same secret as WEBHOOK_SECRET on this control plane. The webhook is signed before Fleet fetches code.</p></div>}
      </div>
    </Panel>
  )
}

const ROLE_CAN: Record<string, string> = {
  viewer: 'read everything: nodes, services, logs, events',
  deployer: 'everything a viewer can, plus deploy, roll back, reschedule and set secrets',
  admin: 'everything a deployer can, plus pair, cordon and drain nodes, edit services and alerts',
  owner: 'everything, plus remove nodes, manage members and billing',
}

export default function Settings() {
  const { fleet, email } = useAuth()
  const isAdmin = fleet?.role === 'owner' || fleet?.role === 'admin'

  const audit = usePoll(
    () => (isAdmin ? api<{ entries: AuditEntry[] }>(`/fleets/${fleet?.id}/audit?limit=40`) : Promise.resolve({ entries: [] })),
    [fleet?.id, isAdmin],
    20000
  )

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[22px] font-semibold tracking-[-0.03em]">Settings</h1>
        <p className="mt-1 text-[13.5px] text-[var(--color-fg-muted)]">Fleet configuration and the audit trail.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="fleet">
          <dl className="divide-y divide-[var(--color-line)]">
            {[
              ['name', fleet?.name ?? '—'],
              ['fleet id', fleet?.id ?? '—'],
              ['your role', fleet?.role ?? '—'],
              ['signed in as', email ?? '—'],
              ['heartbeat interval', `${fleet?.heartbeatIntervalSec}s`],
              ['missed beats before down', String(fleet?.heartbeatMissThreshold)],
              [
                'detection window',
                `${(fleet?.heartbeatIntervalSec ?? 0) * (fleet?.heartbeatMissThreshold ?? 0)}s`,
              ],
              ['default reclaim', fleet?.defaultReclaimPolicy ?? '—'],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-4 px-5 py-2.5">
                <dt className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-[var(--color-fg-dim)]">{k}</dt>
                <dd className="truncate font-mono text-[12px] text-[var(--color-fg-muted)]">{v}</dd>
              </div>
            ))}
          </dl>
        </Panel>

        <Panel title="what your role can do">
          <div className="space-y-3 p-5">
            {Object.entries(ROLE_CAN).map(([role, can]) => (
              <div
                key={role}
                className={`border-l-2 py-1.5 pl-3 ${
                  role === fleet?.role ? 'border-[var(--color-signal)]' : 'border-[var(--color-line)]'
                }`}
              >
                <div
                  className={`font-mono text-[11.5px] ${
                    role === fleet?.role ? 'text-[var(--color-signal)]' : 'text-[var(--color-fg-dim)]'
                  }`}
                >
                  {role}
                  {role === fleet?.role && ' ← you'}
                </div>
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-[var(--color-fg-muted)]">{can}</p>
              </div>
            ))}
            <p className="pt-2 font-mono text-[10.5px] leading-relaxed text-[var(--color-fg-dim)]">
              Roles are enforced at the API, not just in this UI — hiding a button is not access control.
            </p>
          </div>
        </Panel>
      </div>

      {isAdmin && fleet && <GitHubWorkspace fleet={fleet} />}

      {isAdmin && (
        <Panel title="audit log" right={<span className="normal-case">written with the action, not after it</span>}>
          {audit.error ? (
            <div className="p-5">
              <ErrorNote error={audit.error} />
            </div>
          ) : (
            <div className="divide-y divide-[var(--color-line)]">
              {(audit.data?.entries ?? []).map((e) => (
                <div key={e.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-5 py-2.5">
                  <span className="min-w-[92px] font-mono text-[10.5px] text-[var(--color-fg-dim)]">
                    {since(e.createdAt)}
                  </span>
                  <span className="min-w-[190px] font-mono text-[11.5px]">{e.action}</span>
                  <span className="font-mono text-[10.5px] text-[var(--color-fg-dim)]">
                    {e.actorKind} · {e.targetType}
                  </span>
                </div>
              ))}
              {!audit.data?.entries.length && (
                <p className="px-5 py-8 text-center font-mono text-[11px] text-[var(--color-fg-dim)]">
                  no entries yet
                </p>
              )}
            </div>
          )}
        </Panel>
      )}
    </div>
  )
}
