import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { Button, ErrorNote } from '../components/ui'
import { Frame } from './ResetPassword'

/**
 * The wall an unconfirmed account stops at.
 *
 * Signing in used to hand over the entire product to an address nobody had
 * proven they owned. That is worse than untidy: account recovery mails a reset
 * link to that address, so an unverified account is one typo away from being
 * recoverable by a stranger — and a typo is the common case, not an attack.
 *
 * It deliberately does not offer a way past. There is no "skip for now",
 * because a dismissable wall is not a wall, and every account that skipped it
 * would sit in the same unrecoverable state the check exists to prevent.
 */

// Long enough that a double-click cannot spend two of the server's allowance,
// short enough that a genuinely lost mail is not a punishment.
const RESEND_COOLDOWN_S = 45

export default function ConfirmEmail() {
  const { email, refreshMe, signOut } = useAuth()

  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const check = useCallback(
    async (manual: boolean) => {
      if (manual) {
        setChecking(true)
        setError(null)
      }
      try {
        await refreshMe()
      } catch (err) {
        if (manual) setError(err)
      } finally {
        if (manual) setChecking(false)
      }
    },
    [refreshMe]
  )

  // The link is almost always opened in a different tab, which leaves this one
  // showing a wall that no longer applies. Poll so it lets go by itself; the
  // button below is for the reader who does not want to wait for the next tick.
  const poll = useRef(check)
  poll.current = check
  useEffect(() => {
    const t = window.setInterval(() => void poll.current(false), 6000)
    return () => window.clearInterval(t)
  }, [])

  useEffect(() => {
    if (cooldown <= 0) return
    const t = window.setTimeout(() => setCooldown((s) => s - 1), 1000)
    return () => window.clearTimeout(t)
  }, [cooldown])

  const resend = async () => {
    setSending(true)
    setError(null)
    try {
      await api('/auth/resend-verification', { method: 'POST' })
      setSent(true)
      setCooldown(RESEND_COOLDOWN_S)
    } catch (err) {
      setError(err)
    } finally {
      setSending(false)
    }
  }

  return (
    <Frame>
      <h1 className="mt-10 text-[28px] font-semibold leading-tight tracking-[-0.035em]">
        Confirm your email
      </h1>

      <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--color-fg-muted)]">
        We sent a link to{' '}
        <span className="break-all font-mono text-[12.5px] text-[var(--color-fg)]">{email}</span>.
        Open it and this page will let you through on its own.
      </p>

      <p className="mt-4 text-[13.5px] leading-relaxed text-[var(--color-fg-muted)]">
        This is the address your account is recovered through, so it has to be one you can
        actually read.
      </p>

      {sent && (
        <div
          role="status"
          className="mt-5 border-l-2 border-[var(--color-ok)] bg-[var(--color-ok)]/[0.06] px-3 py-2 text-[12.5px] leading-relaxed text-[var(--color-fg-muted)]"
        >
          Sent again. It usually lands within a minute — check spam before asking for another.
        </div>
      )}

      {error != null && (
        <div className="mt-5">
          <ErrorNote error={error} />
        </div>
      )}

      <Button
        variant="primary"
        className="mt-8 w-full"
        disabled={checking}
        onClick={() => void check(true)}
      >
        {checking ? 'Checking…' : "I've confirmed it"}
      </Button>

      <Button
        className="mt-2.5 w-full"
        disabled={sending || cooldown > 0}
        onClick={() => void resend()}
      >
        {sending
          ? 'Sending…'
          : cooldown > 0
            ? `Resend in ${cooldown}s`
            : 'Send the link again'}
      </Button>

      <button
        type="button"
        onClick={signOut}
        className="mt-6 w-full text-center font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-fg-dim)] underline-offset-4 hover:text-[var(--color-fg-muted)] hover:underline"
      >
        Sign out
      </button>

      <p className="mt-5 text-[12.5px] leading-relaxed text-[var(--color-fg-dim)]">
        Wrong address? Sign out and create the account again — an unconfirmed address cannot be
        changed from here, because doing so would let anyone holding a stolen session move the
        account to their own inbox.
      </p>
    </Frame>
  )
}
