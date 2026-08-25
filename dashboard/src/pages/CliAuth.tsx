import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { Button, Panel, Logo } from '../components/ui'

export default function CliAuth() {
  const [params] = useSearchParams()
  const code = params.get('code')
  const port = params.get('port')
  const { email } = useAuth()

  const [status, setStatus] = useState<'idle' | 'approving' | 'success' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  const handleApprove = async () => {
    if (!code) return
    setStatus('approving')
    try {
      const res = await api<{
        accessToken: string
        refreshToken: string
        user: { email: string }
      }>('/auth/cli-session/approve', {
        method: 'POST',
        body: { code },
      })

      // Send to local callback if port is provided
      if (port && Number(port) > 0) {
        try {
          const callbackUrl = new URL(`http://127.0.0.1:${port}/callback`)
          callbackUrl.searchParams.set('accessToken', res.accessToken)
          callbackUrl.searchParams.set('refreshToken', res.refreshToken)
          callbackUrl.searchParams.set('email', res.user.email)
          await fetch(callbackUrl.toString()).catch(() => {})
        } catch {
          // Ignore local fetch errors; CLI also polls
        }
      }

      setStatus('success')
    } catch (err: any) {
      setStatus('error')
      setErrorMsg(err?.message ?? 'Failed to approve CLI session. It may have expired.')
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Panel className="w-full max-w-md p-6 text-center">
        <div className="flex justify-center mb-4">
          <Logo size={40} />
        </div>
        <h1 className="font-mono text-[20px] font-bold">Authorize Fleet CLI</h1>
        <p className="mt-2 text-[13px] text-[var(--color-fg-muted)]">
          A command-line session is requesting access to your Fleet account.
        </p>

        {code && (
          <div className="my-4 rounded border border-[var(--color-line)] bg-[var(--color-bg-subtle)] p-3 font-mono text-[12px]">
            <div>Session: <span className="text-[var(--color-signal)]">{code.slice(0, 16)}…</span></div>
            <div className="mt-1 text-[var(--color-fg-dim)]">Account: {email}</div>
          </div>
        )}

        {status === 'idle' && (
          <div className="mt-6 flex gap-3">
            <Button variant="primary" className="w-full justify-center" onClick={handleApprove}>
              Authorize CLI
            </Button>
          </div>
        )}

        {status === 'approving' && (
          <p className="mt-6 font-mono text-[13px] text-[var(--color-fg-muted)]">Approving session…</p>
        )}

        {status === 'success' && (
          <div className="mt-6 rounded border border-[var(--color-signal)]/30 bg-[var(--color-signal)]/10 p-4">
            <p className="font-mono text-[14px] font-bold text-[var(--color-signal)]">✔ CLI Authorized!</p>
            <p className="mt-1 text-[12px] text-[var(--color-fg-muted)]">
              You can close this browser window and return to your terminal.
            </p>
          </div>
        )}

        {status === 'error' && (
          <div className="mt-6 rounded border border-[var(--color-down)]/30 bg-[var(--color-down)]/10 p-4">
            <p className="font-mono text-[13px] text-[var(--color-down)]">{errorMsg}</p>
          </div>
        )}
      </Panel>
    </div>
  )
}
