import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { Button, ConfirmDialog, Field, Panel, ErrorNote } from './ui'

type Impact = {
  orgId: string
  name: string
  fate: 'deleted' | 'kept'
  fleets: number
  nodes: number
  services: number
}
type State = { graceDays: number; scheduledFor: string | null; impact: Impact[] }

/**
 * Closing an account, from the side of the person doing it.
 *
 * The inventory is fetched and shown before anything is confirmed, because
 * "your account will be deleted" is not informed consent when the real
 * consequence is a fleet and eleven services. Nothing here deletes on click:
 * this only asks the control plane to send a confirmation email, and even that
 * starts a countdown rather than a deletion.
 */
export default function CloseAccount() {
  const [state, setState] = useState<State | null>(null)
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [sent, setSent] = useState(false)

  async function load() {
    try {
      setState(await api<State>('/account/deletion'))
    } catch (err) {
      setError(err)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  async function request() {
    setBusy(true)
    setError(null)
    try {
      await api('/account/deletion', { method: 'POST', body: { password } })
      setSent(true)
      setOpen(false)
      setPassword('')
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  async function cancel() {
    setBusy(true)
    setError(null)
    try {
      await api('/account/deletion', { method: 'DELETE' })
      setSent(false)
      await load()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const doomed = (state?.impact ?? []).filter((o) => o.fate === 'deleted')
  const kept = (state?.impact ?? []).filter((o) => o.fate === 'kept')
  const scheduled = state?.scheduledFor ? new Date(state.scheduledFor) : null

  return (
    <>
      <Panel
        title="close account"
        right={<span className="normal-case text-[var(--color-down)]">permanent</span>}
      >
        <div className="space-y-4 p-5">
          {scheduled ? (
            // The countdown is the loudest thing on the page while it runs.
            <div className="border-l-2 border-[var(--color-down)] pl-4">
              <div className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-down)]">
                scheduled
              </div>
              <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--color-fg)]">
                This account closes on{' '}
                <span className="font-mono">
                  {scheduled.toISOString().replace('T', ' ').slice(0, 16)} UTC
                </span>
                .
              </p>
              <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--color-fg-muted)]">
                Nothing has been deleted yet. Everything still works until then.
              </p>
              <Button className="mt-4" onClick={cancel} disabled={busy}>
                {busy ? 'working…' : 'Keep my account'}
              </Button>
            </div>
          ) : sent ? (
            <div className="border-l-2 border-[var(--color-warn)] pl-4">
              <div className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--color-warn)]">
                check your email
              </div>
              <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--color-fg-muted)]">
                A confirmation link is on its way. It expires in an hour, and following it starts
                a {state?.graceDays ?? 7} day countdown you can still cancel.
              </p>
            </div>
          ) : (
            <>
              <p className="text-[13.5px] leading-relaxed text-[var(--color-fg-muted)]">
                Closing your account deletes the organisations you alone own, and everything
                inside them. Organisations with another owner are left alone.
              </p>

              {doomed.length > 0 && (
                <dl className="border border-[var(--color-line)]">
                  {doomed.map((o) => (
                    <div
                      key={o.orgId}
                      className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-[var(--color-line)] px-4 py-2.5 last:border-b-0"
                    >
                      <dt className="font-mono text-[12px] text-[var(--color-fg)]">{o.name}</dt>
                      <dd className="font-mono text-[11px] text-[var(--color-down)]">
                        {o.fleets} fleet{o.fleets === 1 ? '' : 's'} · {o.nodes} node
                        {o.nodes === 1 ? '' : 's'} · {o.services} service
                        {o.services === 1 ? '' : 's'}
                      </dd>
                    </div>
                  ))}
                  {kept.map((o) => (
                    <div
                      key={o.orgId}
                      className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-[var(--color-line)] px-4 py-2.5 last:border-b-0"
                    >
                      <dt className="font-mono text-[12px] text-[var(--color-fg-dim)]">{o.name}</dt>
                      <dd className="font-mono text-[11px] text-[var(--color-fg-dim)]">
                        kept · another owner remains
                      </dd>
                    </div>
                  ))}
                </dl>
              )}

              <p className="font-mono text-[11px] leading-relaxed text-[var(--color-fg-dim)]">
                Your machines keep running whatever they are running now. Fleet stops managing
                them — run <span className="text-[var(--color-fg-muted)]">fleet unpair</span> on
                each one first if you want them cleaned up.
              </p>

              <Button variant="danger" onClick={() => setOpen(true)}>
                Close account…
              </Button>
            </>
          )}

          <ErrorNote error={error} />
        </div>
      </Panel>

      <ConfirmDialog
        open={open}
        title="Close this account?"
        confirmLabel="Send confirmation email"
        // Typing the phrase is friction on purpose. This is the one action in
        // the product with no undo once its countdown expires.
        confirmPhrase="close my account"
        busy={busy}
        consequences={[
          ...doomed.map(
            (o) =>
              `${o.name}: ${o.fleets} fleet${o.fleets === 1 ? '' : 's'}, ${o.nodes} node${
                o.nodes === 1 ? '' : 's'
              }, ${o.services} service${o.services === 1 ? '' : 's'} deleted`
          ),
          'Deployment history, secrets and backups go with them',
          `You get ${state?.graceDays ?? 7} days to change your mind`,
        ]}
        body={
          <div className="space-y-3">
            <p className="text-[13px] leading-relaxed text-[var(--color-fg-muted)]">
              We will email you a link to confirm. Nothing is deleted until that link is
              followed and the countdown runs out.
            </p>
            <Field
              label="your password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              hint="Confirms it is you, not just an open session on this machine."
            />
          </div>
        }
        onConfirm={request}
        onCancel={() => {
          setOpen(false)
          setPassword('')
          setError(null)
        }}
      />
    </>
  )
}
