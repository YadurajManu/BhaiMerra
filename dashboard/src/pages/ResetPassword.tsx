import { useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { Button, Field, Logo, ErrorNote } from '../components/ui'

/**
 * Two states behind one route.
 *
 * With no `token` in the URL this asks for an address; with one it sets a new
 * password. They live together because that is how the user experiences it —
 * one errand, interrupted by going to their inbox — and splitting it across two
 * routes only creates a second page nobody can navigate to on purpose.
 *
 * Reachable while signed out, which the auth gate has to be told about
 * explicitly: someone resetting a password is by definition not signed in.
 */
export default function ResetPassword() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const token = params.get('token')

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [sent, setSent] = useState(false)
  const [done, setDone] = useState(false)

  const tooShort = password.length > 0 && password.length < 12
  const mismatch = confirm.length > 0 && confirm !== password

  async function request(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api('/auth/forgot', { method: 'POST', body: { email }, auth: false })
      // Shown whether or not an account exists. The API answers identically for
      // both, and a UI that distinguished them would undo that on the client.
      setSent(true)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api('/auth/reset', { method: 'POST', body: { token, password }, auth: false })
      setDone(true)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Frame>
      {done ? (
        <>
          <h1 className="mt-10 text-[28px] font-semibold leading-tight tracking-[-0.035em]">
            Password changed
          </h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--color-fg-muted)]">
            Every other session was signed out. Sign in with the new password.
          </p>
          <Button variant="primary" className="mt-8 w-full" onClick={() => navigate('/')}>
            Sign in
          </Button>
        </>
      ) : sent ? (
        <>
          <h1 className="mt-10 text-[28px] font-semibold leading-tight tracking-[-0.035em]">
            Check your email
          </h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--color-fg-muted)]">
            If an account exists for <span className="text-[var(--color-fg)]">{email}</span>, a
            reset link is on its way. It works once and expires in 30 minutes.
          </p>
          <p className="mt-6 font-mono text-[11.5px] leading-relaxed text-[var(--color-fg-dim)]">
            Nothing arrived? Check spam, then try again in a few minutes — there is a limit on
            how often a link can be sent to one address.
          </p>
          <button
            onClick={() => navigate('/')}
            className="mt-8 font-mono text-[11.5px] text-[var(--color-fg-dim)] transition-colors duration-300 hover:text-[var(--color-fg-muted)]"
          >
            ← Back to sign in
          </button>
        </>
      ) : token ? (
        <>
          <h1 className="mt-10 text-[28px] font-semibold leading-tight tracking-[-0.035em]">
            Choose a new password
          </h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--color-fg-muted)]">
            This signs out every other session on the account.
          </p>

          <form onSubmit={submit} className="mt-8 space-y-5">
            <Field
              label="new password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="at least 12 characters"
              hint={
                tooShort
                  ? `${12 - password.length} more character${12 - password.length === 1 ? '' : 's'}`
                  : 'A passphrase beats a short complicated password.'
              }
            />
            <Field
              label="confirm"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              hint={mismatch ? 'These do not match.' : undefined}
            />
            <ErrorNote error={error} />
            <Button
              type="submit"
              variant="primary"
              className="w-full"
              disabled={busy || tooShort || mismatch || !password}
            >
              {busy ? 'working…' : 'Set new password'}
            </Button>
          </form>
        </>
      ) : (
        <>
          <h1 className="mt-10 text-[28px] font-semibold leading-tight tracking-[-0.035em]">
            Reset your password
          </h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--color-fg-muted)]">
            We will send a link to the address on your account.
          </p>

          <form onSubmit={request} className="mt-8 space-y-5">
            <Field
              label="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
            <ErrorNote error={error} />
            <Button type="submit" variant="primary" className="w-full" disabled={busy || !email}>
              {busy ? 'working…' : 'Send reset link'}
            </Button>
          </form>

          <button
            onClick={() => navigate('/')}
            className="mt-6 font-mono text-[11.5px] text-[var(--color-fg-dim)] transition-colors duration-300 hover:text-[var(--color-fg-muted)]"
          >
            ← Back to sign in
          </button>
        </>
      )}
    </Frame>
  )
}

export function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-16">
      <div className="w-full max-w-[380px] fade-up">
        <Logo size={26} word />
        {children}
        <p className="mt-10 border-t border-[var(--color-line)] pt-5 font-mono text-[10.5px] leading-relaxed text-[var(--color-fg-dim)]">
          Fleet OS will never ask for your password by email. Links in a message you did not
          request should be ignored.
        </p>
      </div>
    </div>
  )
}
