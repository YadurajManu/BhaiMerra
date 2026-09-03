import { useEffect, useRef, useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { Button, ErrorNote } from '../components/ui'
import { Frame } from './ResetPassword'

/**
 * Confirms the address, then gets out of the way.
 *
 * The token is spent on arrival rather than behind a button: the person already
 * expressed intent by clicking the link in their inbox, and asking them to
 * confirm a confirmation is a screen with no purpose.
 */
export default function VerifyEmail() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { refreshMe } = useAuth()
  const token = params.get('token')

  const [state, setState] = useState<'working' | 'done' | 'failed'>(token ? 'working' : 'failed')
  const [error, setError] = useState<unknown>(null)
  // StrictMode mounts effects twice in development. Without this the token is
  // spent by the first run and the second reports it as already used.
  const started = useRef(false)

  useEffect(() => {
    if (!token || started.current) return
    started.current = true
    api('/auth/verify', { method: 'POST', body: { token }, auth: false })
      .then(() => setState('done'))
      .catch((err) => {
        setError(err)
        setState('failed')
      })
  }, [token])

  return (
    <Frame>
      {state === 'working' && (
        <>
          <h1 className="mt-10 text-[28px] font-semibold leading-tight tracking-[-0.035em]">
            Confirming…
          </h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--color-fg-muted)]">
            One moment.
          </p>
        </>
      )}

      {state === 'done' && (
        <>
          <h1 className="mt-10 text-[28px] font-semibold leading-tight tracking-[-0.035em]">
            Email confirmed
          </h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--color-fg-muted)]">
            Your address is on file, so you can recover this account if you ever lose the
            password.
          </p>
          <Button
            variant="primary"
            className="mt-8 w-full"
            onClick={() => {
              // Navigating alone is not enough when the link was opened in the
              // same tab that is signed in: the gate reads verification from
              // auth state, which still says false until /auth/me is asked
              // again. Without this the reader confirms their address and is
              // returned to the screen telling them to confirm their address.
              void refreshMe()
                .catch(() => {})
                .finally(() => navigate('/'))
            }}
          >
            Continue
          </Button>
        </>
      )}

      {state === 'failed' && (
        <>
          <h1 className="mt-10 text-[28px] font-semibold leading-tight tracking-[-0.035em]">
            That link did not work
          </h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--color-fg-muted)]">
            Confirmation links last 24 hours and work once. This one is expired, already used,
            or incomplete — mail clients sometimes wrap a long link across two lines.
          </p>
          <div className="mt-5">
            <ErrorNote error={error} />
          </div>
          <p className="mt-4 text-[13.5px] leading-relaxed text-[var(--color-fg-muted)]">
            Sign in and request a new one from Settings.
          </p>
          <Button variant="primary" className="mt-8 w-full" onClick={() => navigate('/')}>
            Sign in
          </Button>
        </>
      )}
    </Frame>
  )
}
