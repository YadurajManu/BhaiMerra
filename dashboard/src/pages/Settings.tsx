import { useEffect, useMemo, useState } from 'react'
import { api, type AuditEntry } from '../lib/api'
import { useAuth, usePoll } from '../lib/auth'
import { since } from '../lib/format'
import { Button, Copyable, ErrorNote, Field, Panel } from '../components/ui'
import CloseAccount from '../components/CloseAccount'

type GitHubStatus = {
  configured: boolean
  webhookBase: string
  clientId?: string | null
  /** False when the control plane knows the App by id but not by slug. */
  canInstall?: boolean
  /** Set when GITHUB_APP_SLUG names a different App than the private key does. */
  misconfiguredSlug?: { configured: string; actual: string }
  /** Installs that exist on GitHub but were never bound to an organisation. */
  unclaimedInstallations?: number
  error?: string
  installations?: Array<{
    id: number
    account: string
    type: string
    suspended: boolean
    /** null when GitHub could not be reached to confirm. */
    active: boolean | null
  }>
}

type GitHubRepo = { fullName: string; cloneUrl: string; private: boolean; defaultBranch: string; updatedAt: string }
type ConnectedRepo = {
  id: string; account: string; fullName: string; cloneUrl: string; defaultBranch: string; branch: string
  manifestPath: string; isPrivate: boolean; services: string[]; createdAt: string
}

/**
 * What the setup callback's `reason` codes mean, in words. The redirect can
 * only carry a short code, and a code in a URL bar helps nobody.
 */
const SETUP_REASONS: Record<string, string> = {
  app_slug_mismatch:
    'GITHUB_APP_SLUG names a different GitHub App than the configured App ID and private key, so the App you just installed is not the one this control plane can read. Point the slug at the App the key belongs to, then try again.',
  expired_or_unrecognised_link:
    'That install link had expired, or the install did not start from this page. Links are valid for ten minutes and can be used once.',
  installation_not_visible_to_this_app:
    'GitHub reported an installation this App cannot see. If you have more than one Fleet App, check that the one you installed matches the configured App ID.',
  awaiting_owner_approval:
    'You requested the App on an organisation you do not own. An owner has to approve it first, then come back and connect.',
  installation_claimed: 'That GitHub account is already connected to a different Fleet organisation.',
  github_unreachable: 'Could not reach GitHub to confirm the installation. Check the App private key, then try again.',
  no_installation_id: 'GitHub returned from the install without an installation id.',
  github_not_configured: 'This control plane has no GitHub App configured.',
  malformed_callback: 'The callback from GitHub was malformed.',
}

function GitHubWorkspace({ fleet }: { fleet: NonNullable<ReturnType<typeof useAuth>['fleet']> }) {
  const [installationId, setInstallationId] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<GitHubRepo | null>(null)
  const [branch, setBranch] = useState('')
  const [manifestPath, setManifestPath] = useState('fleet.yaml')
  const [busy, setBusy] = useState(false)
  const [importNote, setImportNote] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
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
    setBusy(true); setActionError(null); setImportNote(null)
    try {
      const result = await api<{ deploying?: { sha: string }; notDeployed?: string }>(
        `/fleets/${fleet.id}/github/repositories`,
        {
          method: 'POST',
          body: { installationId: activeInstallation, fullName: selected.fullName, branch, manifestPath },
        }
      )
      // Importing starts a deploy. Say which, because the alternative is a
      // screen that looks identical whether anything happened or not.
      setImportNote(
        result.deploying
          ? { tone: 'ok', text: `${selected.fullName} is deploying at ${result.deploying.sha.slice(0, 7)}. Follow it on the Services page.` }
          : { tone: 'warn', text: `${selected.fullName} is connected, but nothing was deployed: ${result.notDeployed ?? 'no reason given'}.` }
      )
      setRevision((value) => value + 1)
      setSelected(null)
    } catch (err) { setActionError(err) } finally { setBusy(false) }
  }

  /**
   * Hand off to GitHub's install flow. The URL is minted per click because it
   * carries a single-use state that binds whatever gets installed back to this
   * org — a static link to the App page would install fine and belong to
   * nobody.
   */
  async function connectAccount() {
    setBusy(true); setActionError(null)
    try {
      const { url } = await api<{ url: string }>(`/fleets/${fleet.id}/github/install-url`, { method: 'POST' })
      window.location.href = url
    } catch (err) { setActionError(err); setBusy(false) }
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

  // The setup callback lands back here with the outcome in the query string.
  // Read once on mount: it describes that redirect, not the current state.
  const [returned, setReturned] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    const outcome = params.get('github')
    return outcome ? { outcome, reason: params.get('reason') } : null
  })
  const slugProblem = status.data?.misconfiguredSlug

  return (
    <Panel title="GitHub" right={<span className="normal-case">import · deploy on push</span>}>
      <div className="p-5">
        <ErrorNote error={status.error ?? actionError} />

        {returned && (
          <div
            className={`mb-4 flex items-start gap-3 border-l-2 p-4 ${
              returned.outcome === 'connected'
                ? 'border-[var(--color-signal)] bg-[color-mix(in_oklab,var(--color-signal)_5%,transparent)]'
                : 'border-[var(--color-warn)] bg-[color-mix(in_oklab,var(--color-warn)_5%,transparent)]'
            }`}
          >
            <div className="min-w-0 flex-1">
              <p className={`font-mono text-[12px] ${returned.outcome === 'connected' ? 'text-[var(--color-signal)]' : 'text-[var(--color-warn)]'}`}>
                {returned.outcome === 'connected' ? 'GitHub account connected' : 'GitHub could not be connected'}
              </p>
              {returned.outcome !== 'connected' && (
                <p className="mt-2 max-w-[80ch] text-[12.5px] leading-relaxed text-[var(--color-fg-muted)]">
                  {(returned.reason && SETUP_REASONS[returned.reason]) ?? `GitHub returned "${returned.reason ?? 'an unknown error'}".`}
                </p>
              )}
            </div>
            <Button
              onClick={() => {
                setReturned(null)
                window.history.replaceState({}, '', window.location.pathname)
              }}
            >
              Dismiss
            </Button>
          </div>
        )}

        {importNote && (
          <div
            className={`mb-4 flex items-start gap-3 border-l-2 p-4 ${
              importNote.tone === 'ok'
                ? 'border-[var(--color-signal)] bg-[color-mix(in_oklab,var(--color-signal)_5%,transparent)]'
                : 'border-[var(--color-warn)] bg-[color-mix(in_oklab,var(--color-warn)_5%,transparent)]'
            }`}
          >
            <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-[var(--color-fg-muted)]">{importNote.text}</p>
            <Button onClick={() => setImportNote(null)}>Dismiss</Button>
          </div>
        )}

        {slugProblem && (
          <div className="mb-4 border-l-2 border-[var(--color-warn)] bg-[color-mix(in_oklab,var(--color-warn)_5%,transparent)] p-4">
            <p className="font-mono text-[12px] text-[var(--color-warn)]">GitHub App misconfigured</p>
            <p className="mt-2 max-w-[80ch] text-[12.5px] leading-relaxed text-[var(--color-fg-muted)]">
              GITHUB_APP_SLUG is <span className="font-mono text-[var(--color-fg)]">{slugProblem.configured}</span>, but the configured App ID and private key belong to{' '}
              <span className="font-mono text-[var(--color-fg)]">{slugProblem.actual}</span>. Anyone following the connect button would install the wrong App, and it would connect nothing. Set the slug to{' '}
              <span className="font-mono text-[var(--color-fg)]">{slugProblem.actual}</span> and restart the control plane.
            </p>
          </div>
        )}

        {!status.data?.configured ? (
          <div className="border-l-2 border-[var(--color-warn)] bg-[color-mix(in_oklab,var(--color-warn)_5%,transparent)] p-4">
            <p className="font-mono text-[12px] text-[var(--color-warn)]">GitHub App required to browse and connect repositories</p>
            <p className="mt-2 max-w-[78ch] text-[12.5px] leading-relaxed text-[var(--color-fg-muted)]">
              Configure the control plane with a GitHub App private key, then install that App on only the accounts and repositories Fleet may read. The App needs Contents: read-only and Repository webhooks: read &amp; write. Fleet never stores a personal access token.
            </p>
          </div>
        ) : !installations.length ? (
          /* One decision, one button. Everything else on this screen is
             meaningless until an account is connected, so none of it is shown. */
          <div className="flex flex-col items-center border border-[var(--color-line)] bg-[var(--color-ink-950)] px-6 py-14 text-center">
            <svg viewBox="0 0 16 16" width="32" height="32" aria-hidden="true" className="fill-[var(--color-fg-muted)]">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
            <p className="mt-4 font-mono text-[13px] text-[var(--color-fg)]">Connect your GitHub</p>
            <p className="mt-2 max-w-[54ch] text-[12.5px] leading-relaxed text-[var(--color-fg-muted)]">
              Deploy straight from your repositories. You choose which ones Fleet may see, and the account is bound to this organisation alone.
            </p>
            {status.data?.canInstall ? (
              <div className="mt-5">
                <Button variant="primary" onClick={() => void connectAccount()} disabled={busy}>
                  {busy ? 'opening GitHub…' : 'Continue with GitHub'}
                </Button>
              </div>
            ) : (
              <p className="mt-5 max-w-[54ch] text-[12px] leading-relaxed text-[var(--color-warn)]">
                This control plane knows the App by id but not by name, so it cannot link to the install page. Set GITHUB_APP_SLUG to the value in https://github.com/apps/&lt;slug&gt;.
              </p>
            )}

            {/* The install worked on GitHub's side and never came back here.
                Practically always a missing Setup URL on the App. */}
            {Boolean(status.data?.unclaimedInstallations) && (
              <div className="mt-6 w-full max-w-[62ch] border-l-2 border-[var(--color-warn)] bg-[color-mix(in_oklab,var(--color-warn)_5%,transparent)] p-4 text-left">
                <p className="font-mono text-[12px] text-[var(--color-warn)]">
                  {status.data!.unclaimedInstallations} installation{status.data!.unclaimedInstallations === 1 ? '' : 's'} of this App exist on GitHub but are not connected to any organisation
                </p>
                <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--color-fg-muted)]">
                  That means the App has no <span className="font-mono text-[var(--color-fg)]">Setup URL</span>, so GitHub finishes an install and never returns here to record who it belongs to. Set it on the App — the exact value is under <span className="text-[var(--color-fg)]">Operator setup</span> below — then press Continue with GitHub again.
                </p>
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
              <div>
                <p className="font-mono text-[12.5px] text-[var(--color-fg)]">Import a repository</p>
                <p className="mt-1 text-[12px] text-[var(--color-fg-dim)]">Its fleet.yaml becomes services on the first push.</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {installations.map((installation) => (
                  <Button
                    key={installation.id}
                    onClick={() => { setInstallationId(installation.id); setSelected(null) }}
                    variant={activeInstallation === installation.id ? 'primary' : 'ghost'}
                  >
                    {installation.account}
                    {installation.suspended && <span className="ml-1.5 text-[var(--color-warn)]">suspended</span>}
                    {installation.active === false && <span className="ml-1.5 text-[var(--color-warn)]">uninstalled</span>}
                  </Button>
                ))}
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search repositories…"
                  className="w-56 border border-[var(--color-line)] bg-[var(--color-ink-950)] px-3 py-2 font-mono text-[11.5px] outline-none focus:border-[var(--color-line-2)]"
                />
              </div>
            </div>

            <div className="mt-4 max-h-[22rem] divide-y divide-[var(--color-line)] overflow-y-auto border border-[var(--color-line)]">
              {catalog.loading ? (
                <p className="p-4 font-mono text-[11px] text-[var(--color-fg-dim)]">loading repositories…</p>
              ) : visibleRepos.map((repo) => {
                const alreadyConnected = connected.data?.repositories.some((entry) => entry.fullName === repo.fullName)
                return (
                  <div
                    key={repo.fullName}
                    className={`flex items-center gap-3 px-4 py-2.5 transition-colors ${selected?.fullName === repo.fullName ? 'bg-[var(--color-ink-800)]' : ''}`}
                  >
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${repo.private ? 'bg-[var(--color-warn)]' : 'bg-[var(--color-signal)]'}`} />
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{repo.fullName}</span>
                    <span className="hidden font-mono text-[10px] text-[var(--color-fg-dim)] sm:inline">
                      {repo.private ? 'private' : 'public'} · {repo.defaultBranch}
                    </span>
                    {alreadyConnected ? (
                      <span className="font-mono text-[10.5px] text-[var(--color-signal)]">connected</span>
                    ) : (
                      <Button onClick={() => setSelected(repo)} variant={selected?.fullName === repo.fullName ? 'primary' : 'ghost'}>
                        Import
                      </Button>
                    )}
                  </div>
                )
              })}
              {!catalog.loading && !visibleRepos.length && <p className="p-4 text-[12px] text-[var(--color-fg-dim)]">No repositories match this search.</p>}
            </div>

            {status.data?.canInstall && (
              <p className="mt-2.5 text-[12px] text-[var(--color-fg-dim)]">
                Missing a repository?{' '}
                <button
                  onClick={() => void connectAccount()}
                  disabled={busy}
                  className="underline underline-offset-2 hover:text-[var(--color-fg)] disabled:opacity-50"
                >
                  Adjust what Fleet can see, or add another account
                </button>
              </p>
            )}

            {selected && (
              <div className="mt-5 border border-[var(--color-line-2)] bg-[var(--color-ink-900)] p-4 fade-up">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <p className="font-mono text-[12px] text-[var(--color-fg)]">Import {selected.fullName}</p>
                  <span className="font-mono text-[10px] text-[var(--color-fg-dim)]">{selected.private ? 'private — App token required' : 'public repository'}</span>
                </div>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <Field label="watch branch" value={branch} onChange={(event) => setBranch(event.target.value)} hint="Only pushes to this branch trigger Fleet." />
                  <Field label="manifest path" value={manifestPath} onChange={(event) => setManifestPath(event.target.value)} hint="Relative path, normally fleet.yaml." />
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Button variant="primary" onClick={() => void connect()} disabled={busy || !branch.trim() || !manifestPath.trim()}>{busy ? 'importing…' : 'Import repository'}</Button>
                  <Button onClick={() => setSelected(null)} disabled={busy}>Cancel</Button>
                </div>
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

        {/* Operator-only, and a one-time job. Collapsed so the everyday screen
            is a repository list and nothing else. */}
        {webhookUrl && (
          <details className="mt-6 border-t border-[var(--color-line)] pt-5">
            <summary className="cursor-pointer font-mono text-[11.5px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]">
              Operator setup — App URLs and webhook delivery
            </summary>
            <div className="mt-4">
              <p className="font-mono text-[11.5px] text-[var(--color-fg)]">GitHub App settings</p>
              <p className="mt-2 max-w-[80ch] text-[12px] leading-relaxed text-[var(--color-fg-dim)]">
                Set these two on the App itself, once. <span className="text-[var(--color-fg-muted)]">Setup URL</span> is where GitHub returns a browser after an install — it is what binds the installation to this organisation, and without it “Continue with GitHub” installs the App but connects nothing. <span className="text-[var(--color-fg-muted)]">Webhook URL</span> receives installation events, so uninstalling the App revokes Fleet&rsquo;s access immediately.
              </p>
              <div className="mt-2 grid gap-2"><Copyable text={`${status.data!.webhookBase}/github/setup`} /><Copyable text={`${status.data!.webhookBase}/webhooks/github`} /></div>

              <p className="mt-5 font-mono text-[11.5px] text-[var(--color-fg)]">Per-repository push webhook</p>
              <p className="mt-2 max-w-[80ch] text-[12px] leading-relaxed text-[var(--color-fg-dim)]">
                Not needed for repositories imported above — pushes for those arrive at the App&rsquo;s own webhook already. This is for a repository Fleet reaches some other way, such as one hosted outside GitHub. Repository Settings → Webhooks → Add webhook, JSON, “Just the push event”, same secret as WEBHOOK_SECRET.
              </p>
              <div className="mt-2"><Copyable text={webhookUrl} /></div>
            </div>
          </details>
        )}
      </div>
    </Panel>
  )
}

/**
 * The fleet's settings, as settings rather than as facts about settings.
 *
 * This was eight read-only rows beside a panel listing all four roles. Three
 * of the rows were one idea — interval, threshold, and the product of the two
 * — two more repeated the header, and the role panel was documentation that
 * never changed for anyone and mostly described roles the reader does not
 * have. Meanwhile the four values the schema calls per-fleet had no way to be
 * changed at all: there was no update route.
 */
function FleetSettings() {
  const { fleet, refreshFleets } = useAuth()
  const canEdit = fleet?.role === 'owner' || fleet?.role === 'admin'

  const [name, setName] = useState('')
  const [interval, setInterval] = useState(5)
  const [threshold, setThreshold] = useState(3)
  const [reclaim, setReclaim] = useState('idle')
  const [autoUpgrade, setAutoUpgrade] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<unknown>(null)

  // Re-seed whenever the fleet arrives or the selection changes, so the form
  // never shows one fleet's values under another's name.
  useEffect(() => {
    if (!fleet) return
    setName(fleet.name)
    setInterval(fleet.heartbeatIntervalSec)
    setThreshold(fleet.heartbeatMissThreshold)
    setReclaim(fleet.defaultReclaimPolicy)
    setAutoUpgrade(fleet.agentAutoUpgrade)
    setError(null)
    setSaved(false)
  }, [fleet?.id, fleet?.name, fleet?.heartbeatIntervalSec, fleet?.heartbeatMissThreshold, fleet?.defaultReclaimPolicy]) // eslint-disable-line react-hooks/exhaustive-deps

  const detection = interval * threshold
  const dirty =
    !!fleet &&
    (name !== fleet.name ||
      interval !== fleet.heartbeatIntervalSec ||
      threshold !== fleet.heartbeatMissThreshold ||
      reclaim !== fleet.defaultReclaimPolicy ||
      autoUpgrade !== fleet.agentAutoUpgrade)

  // Mirrors the server's rule rather than trusting the button to be enough.
  const tooWide = detection > 300
  const invalid =
    !name.trim() || interval < 1 || interval > 60 || threshold < 1 || threshold > 10 || tooWide

  const save = async () => {
    if (!fleet) return
    setSaving(true)
    setError(null)
    try {
      await api(`/fleets/${fleet.id}`, {
        method: 'PATCH',
        body: {
          name: name.trim(),
          heartbeatIntervalSec: interval,
          heartbeatMissThreshold: threshold,
          defaultReclaimPolicy: reclaim,
          agentAutoUpgrade: autoUpgrade,
        },
      })
      await refreshFleets()
      setSaved(true)
    } catch (err) {
      setError(err)
    } finally {
      setSaving(false)
    }
  }

  if (!fleet) return null

  return (
    <Panel
      title="fleet"
      right={
        <span className="normal-case text-[var(--color-fg-dim)]">
          you are {fleet.role} · enforced at the API, not by hiding buttons
        </span>
      }
    >
      <div className="space-y-5 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="name"
            value={name}
            disabled={!canEdit}
            maxLength={64}
            onChange={(e) => setName(e.target.value)}
          />
          <div>
            <label className="mono-label block text-[10px] text-[var(--color-fg-dim)]">
              default reclaim
            </label>
            <select
              value={reclaim}
              disabled={!canEdit}
              onChange={(e) => setReclaim(e.target.value)}
              className="mt-1.5 h-[34px] w-full border border-[var(--color-line-2)] bg-[var(--color-ink-900)] px-2.5 font-mono text-[12px] text-[var(--color-fg)] transition-colors focus:border-[var(--color-signal)] focus:outline-none disabled:opacity-60"
            >
              <option value="idle">idle — reclaim once nothing is running</option>
              <option value="eager">eager — reclaim as soon as it can</option>
              <option value="manual">manual — never reclaim on its own</option>
            </select>
          </div>
        </div>

        <div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="heartbeat interval"
              hint="seconds between beats · 1–60"
              type="number"
              min={1}
              max={60}
              value={interval}
              disabled={!canEdit}
              onChange={(e) => setInterval(Number(e.target.value))}
            />
            <Field
              label="missed beats before down"
              hint="1–10"
              type="number"
              min={1}
              max={10}
              value={threshold}
              disabled={!canEdit}
              onChange={(e) => setThreshold(Number(e.target.value))}
            />
          </div>

          {/* The old page listed this as a third row of equal weight. It is
              not a third setting — it is what the two above multiply to, and
              it is the number that actually matters, so it reads as a
              consequence of them. */}
          <p
            className="mt-2.5 border-l-2 py-1 pl-3 font-mono text-[11px] leading-relaxed"
            style={{
              borderColor: tooWide ? 'var(--color-warn)' : 'var(--color-line-2)',
              color: tooWide ? 'var(--color-warn)' : 'var(--color-fg-muted)',
            }}
          >
            {tooWide
              ? `${detection}s is too long to wait before calling a node down. Keep interval × missed beats at 300s or less.`
              : `A node is called down after ${detection}s of silence.`}
          </p>
        </div>

        <label className="flex cursor-pointer items-start gap-3 border-t border-[var(--color-line)] pt-4">
          <input
            type="checkbox"
            checked={autoUpgrade}
            disabled={!canEdit}
            onChange={(e) => setAutoUpgrade(e.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--color-signal)]"
          />
          <span className="min-w-0">
            <span className="mono-label block text-[10px] text-[var(--color-fg-dim)]">
              KEEP AGENTS UP TO DATE
            </span>
            <span className="mt-1 block text-[12.5px] leading-relaxed text-[var(--color-fg-muted)]">
              Nodes in this fleet replace their own agent with the build this control plane
              serves, verifying its checksum first and restarting to install it. Off by default:
              on for everyone would mean one bad build reaching every node at once, so turn it on
              for the fleet you are willing to move first.
            </span>
          </span>
        </label>

        {error != null && <ErrorNote error={error} />}

        {canEdit ? (
          <div className="flex items-center gap-3">
            <Button variant="primary" onClick={() => void save()} disabled={!dirty || invalid || saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
            {dirty && !saving && (
              <button
                onClick={() => {
                  setName(fleet.name)
                  setInterval(fleet.heartbeatIntervalSec)
                  setThreshold(fleet.heartbeatMissThreshold)
                  setReclaim(fleet.defaultReclaimPolicy)
                }}
                className="font-mono text-[11px] text-[var(--color-fg-dim)] underline-offset-4 hover:text-[var(--color-fg)] hover:underline"
              >
                discard
              </button>
            )}
            {saved && !dirty && (
              <span className="font-mono text-[11px] text-[var(--color-signal)]">saved</span>
            )}
          </div>
        ) : (
          <p className="font-mono text-[11px] text-[var(--color-fg-dim)]">
            Changing these needs admin. Ask an owner of this fleet.
          </p>
        )}

        <div className="flex items-center gap-3 border-t border-[var(--color-line)] pt-4">
          <span className="mono-label shrink-0 text-[10px] text-[var(--color-fg-dim)]">FLEET ID</span>
          {/* Kept because the CLI and every support question needs it, but as
              one copyable line rather than a row competing with the settings. */}
          <Copyable text={fleet.id} className="text-[11px]" />
        </div>
      </div>
    </Panel>
  )
}



export default function Settings() {
  const { fleet } = useAuth()
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

      <FleetSettings />

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

      {/* Last on the page on purpose: the most destructive control should not
          sit next to routine settings where it can be reached by accident. */}
      <CloseAccount />
    </div>
  )
}
