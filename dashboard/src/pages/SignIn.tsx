import { useState } from 'react'
import { useAuth } from '../lib/auth'
import { Button, Field, Logo, Dot, ErrorNote } from '../components/ui'

const FACTS = [
  ['agent footprint', '< 50 MB'],
  ['architectures', 'arm64 · armv7 · amd64'],
  ['reschedule after heartbeat loss', '~4 s'],
  ['ports forwarded', '0'],
] as const

export default function SignIn() {
  const { signIn, signUp } = useAuth()
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const tooShort = mode === 'up' && password.length > 0 && password.length < 12

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await (mode === 'in' ? signIn(email, password) : signUp(email, password))
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* form */}
      <div className="flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-[380px] fade-up">
          <Logo size={26} word />

          <h1 className="mt-10 text-[28px] font-semibold leading-tight tracking-[-0.035em]">
            {mode === 'in' ? 'Sign in' : 'Create an account'}
          </h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--color-fg-muted)]">
            {mode === 'in'
              ? 'Your fleet is where you left it.'
              : 'You get an org and a fleet called homelab. Add your first node straight after.'}
          </p>

          <form onSubmit={submit} className="mt-8 space-y-5">
            <Field
              label="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
            <Field
              label="password"
              type="password"
              autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'up' ? 'at least 12 characters' : ''}
              hint={
                mode === 'up'
                  ? tooShort
                    ? `${12 - password.length} more character${12 - password.length === 1 ? '' : 's'}`
                    : 'A passphrase beats a short complicated password.'
                  : undefined
              }
            />

            <ErrorNote error={error} />

            <Button type="submit" variant="primary" className="w-full" disabled={busy || tooShort}>
              {busy ? 'working…' : mode === 'in' ? 'Sign in' : 'Create account'}
            </Button>
          </form>

          <button
            onClick={() => {
              setMode(mode === 'in' ? 'up' : 'in')
              setError(null)
            }}
            className="mt-6 font-mono text-[11.5px] text-[var(--color-fg-dim)] transition-colors duration-300 hover:text-[var(--color-fg-muted)]"
          >
            {mode === 'in' ? 'No account? Create one →' : 'Already have an account? Sign in →'}
          </button>

          <p className="mt-10 border-t border-[var(--color-line)] pt-5 font-mono text-[10.5px] leading-relaxed text-[var(--color-fg-dim)]">
            Self-hosting? This dashboard talks to whichever control plane it was
            built against — there is no hosted account required.
          </p>
        </div>
      </div>

      {/* the product, stated plainly rather than decorated */}
      <div className="relative hidden overflow-hidden border-l border-[var(--color-line)] bg-[var(--color-ink-900)] lg:block">
        <div className="pointer-events-none absolute inset-0 grid-bg opacity-70" />
        <div className="relative flex h-full flex-col justify-center px-14">
          <div className="inline-flex w-fit items-center gap-2.5 border border-[var(--color-line)] bg-[var(--color-ink-950)] px-3 py-1.5">
            <Dot size={6} />
            <span className="font-mono text-[10.5px] tracking-[0.1em] text-[var(--color-fg-muted)]">
              CONTROL PLANE
            </span>
          </div>

          <h2 className="mt-7 max-w-[16ch] text-[clamp(2rem,3.2vw,2.9rem)] font-semibold leading-[0.98] tracking-[-0.04em]">
            Your hardware.
            <span className="block text-[var(--color-fg-dim)]">Orchestrated like a platform.</span>
          </h2>

          <dl className="mt-12 grid max-w-[440px] grid-cols-2 gap-x-8 gap-y-6">
            {FACTS.map(([label, value]) => (
              <div key={label}>
                <dt className="mono-label normal-case tracking-[0.08em]">{label}</dt>
                <dd className="mt-1.5 font-mono text-[15px] tracking-[-0.01em]">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  )
}
