import { api, type AuditEntry } from '../lib/api'
import { useAuth, usePoll } from '../lib/auth'
import { since } from '../lib/format'
import { Copyable, ErrorNote, Panel } from '../components/ui'

type GitHubStatus = {
  configured: boolean
  webhookBase: string
  clientId?: string | null
  error?: string
  installations?: Array<{ id: number; account: string; type: string }>
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
  const github = usePoll(
    () => (isAdmin ? api<GitHubStatus>('/github/status') : Promise.resolve(null)),
    [isAdmin],
    30_000
  )
  const webhookUrl = github.data && fleet ? `${github.data.webhookBase}/webhooks/git/${fleet.id}` : null

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

      {isAdmin && (
        <Panel title="GitHub deploys" right={<span className="normal-case">push → fleet.yaml → build → deploy</span>}>
          <div className="space-y-4 p-5">
            {github.error ? (
              <ErrorNote error={github.error} />
            ) : github.data?.configured ? (
              <div>
                <p className="text-[13px] text-[var(--color-signal)]">GitHub App configured</p>
                <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-fg-muted)]">
                  Installed for {github.data.installations?.length ?? 0} account{github.data.installations?.length === 1 ? '' : 's'}.
                  Add a repository URL with <code>repo:</code> to each service in <code>fleet.yaml</code>.
                </p>
              </div>
            ) : (
              <div>
                <p className="text-[13px] text-[var(--color-warn)]">GitHub App not configured</p>
                <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-fg-muted)]">
                  Public repositories can still be fetched, but private repositories need a GitHub App with read-only Contents access.
                </p>
              </div>
            )}

            {webhookUrl && (
              <div className="border-t border-[var(--color-line)] pt-4">
                <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-fg-dim)]">GitHub webhook URL</p>
                <div className="mt-2"><Copyable text={webhookUrl} /></div>
                <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-fg-dim)]">
                  In GitHub: repository Settings → Webhooks → Add webhook. Choose JSON and “Just the push event”. Set the same secret as <code>WEBHOOK_SECRET</code> on this control plane.
                </p>
              </div>
            )}
          </div>
        </Panel>
      )}

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
