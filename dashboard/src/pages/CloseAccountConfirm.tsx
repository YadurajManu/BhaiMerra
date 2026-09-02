import { useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { Button, ErrorNote } from '../components/ui'
import { Frame } from './ResetPassword'

/**
 * Where the confirmation link from the email lands.
 *
 * Unlike email verification, this does NOT spend the token on arrival. Opening
 * a link should never be what starts destroying infrastructure — link
 * prefetchers, mail scanners and antivirus proxies all follow URLs in email
 * without a person seeing them. So the page asks, and the button is the
 * consent.
 *
 * Public on purpose: whoever is closing the account may not be signed in on
 * the device where they read their email.
 */
export default function CloseAccountConfirm() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const token = params.get('token')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [scheduled, setScheduled] = useState<{ scheduledFor: string; graceDays: number } | null>(
    null
  )

  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      setScheduled(
        await api<{ scheduledFor: string; graceDays: number }>('/account/deletion/confirm', {
          method: 'POST',
          body: { token },
          auth: false,
        })
      )
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  if (!token) {
    return (
      <Frame>
        <h1 className="mt-10 text-[28px] font-semibold leading-tight tracking-[-0.035em]">
          Nothing to confirm
        </h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--color-fg-muted)]">
          This link is incomplete. Start again from Settings if you meant to close your account.
        </p>
        <Button variant="primary" className="mt-8 w-full" onClick={() => navigate('/')}>
          Go to the dashboard
        </Button>
      </Frame>
    )
  }

  if (scheduled) {
    const when = new Date(scheduled.scheduledFor)
    return (
      <Frame>
        <h1 className="mt-10 text-[28px] font-semibold leading-tight tracking-[-0.035em]">
          Countdown started
        </h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--color-fg-muted)]">
          Your account closes on{' '}
          <span className="font-mono text-[var(--color-fg)]">
            {when.toISOString().replace('T', ' ').slice(0, 16)} UTC
          </span>
          . Nothing has been deleted, and everything works normally until then.
        </p>
        <p className="mt-4 text-[13.5px] leading-relaxed text-[var(--color-fg-muted)]">
          Changed your mind? Sign in and cancel from Settings. That is all it takes.
        </p>
        <Button variant="primary" className="mt-8 w-full" onClick={() => navigate('/')}>
          Sign in
        </Button>
      </Frame>
    )
  }

  return (
    <Frame>
      <h1 className="mt-10 text-[28px] font-semibold leading-tight tracking-[-0.035em]">
        Close your account?
      </h1>
      <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--color-fg-muted)]">
        This starts the countdown. Your organisations, fleets, services, deployment history,
        secrets and backups are deleted when it runs out.
      </p>
      <p className="mt-4 text-[13.5px] leading-relaxed text-[var(--color-fg-muted)]">
        You can cancel at any point before then by signing in.
      </p>

      <div className="mt-6">
        <ErrorNote error={error} />
      </div>

      <Button variant="danger" className="mt-6 w-full" onClick={confirm} disabled={busy}>
        {busy ? 'working…' : 'Yes, start the countdown'}
      </Button>
      <button
        onClick={() => navigate('/')}
        className="mt-4 w-full font-mono text-[11.5px] text-[var(--color-fg-dim)] transition-colors duration-300 hover:text-[var(--color-fg-muted)]"
      >
        No, keep my account
      </button>
    </Frame>
  )
}
