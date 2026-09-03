import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, session, type Fleet } from './api'

type Me = {
  user: { id: string; email: string; emailVerifiedAt: string | null }
  orgs: Array<{ orgName: string; role: string; plan: string }>
}

type AuthState = {
  ready: boolean
  email: string | null
  /** Null until /auth/me has answered, so the gate can wait rather than guess. */
  verified: boolean | null
  fleets: Fleet[]
  fleet: Fleet | null
  selectFleet: (id: string) => void
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string) => Promise<void>
  signOut: () => void
  refreshFleets: () => Promise<void>
  /** Re-read /auth/me. The confirmation link is usually opened in another tab,
      so this tab has to be able to notice without a full reload. */
  refreshMe: () => Promise<boolean>
}

const Ctx = createContext<AuthState | null>(null)
const LAST_FLEET = 'fleet-os.fleet'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [email, setEmail] = useState<string | null>(null)
  const [verified, setVerified] = useState<boolean | null>(null)
  const [fleets, setFleets] = useState<Fleet[]>([])
  const [fleetId, setFleetId] = useState<string | null>(() => localStorage.getItem(LAST_FLEET))

  const loadFleets = useCallback(async () => {
    const { fleets } = await api<{ fleets: Fleet[] }>('/fleets')
    setFleets(fleets)
    setFleetId((current) => {
      // Keep the current selection if it still exists; a fleet being removed
      // should not silently switch the user to someone else's data.
      if (current && fleets.some((f) => f.id === current)) return current
      return fleets[0]?.id ?? null
    })
  }, [])

  const refreshMe = useCallback(async () => {
    const me = await api<Me>('/auth/me')
    setEmail(me.user.email)
    const ok = me.user.emailVerifiedAt != null
    setVerified(ok)
    return ok
  }, [])

  const bootstrap = useCallback(async () => {
    if (!session.get()?.accessToken) {
      setReady(true)
      return
    }
    try {
      const ok = await refreshMe()
      // Fleets are only fetched once the address is confirmed. An unverified
      // account has nothing to show, and asking for them anyway means a failed
      // request behind the confirmation screen for no benefit.
      if (ok) await loadFleets()
    } catch {
      session.clear()
      setEmail(null)
      setVerified(null)
    } finally {
      setReady(true)
    }
  }, [loadFleets, refreshMe])

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  useEffect(() => {
    if (fleetId) localStorage.setItem(LAST_FLEET, fleetId)
  }, [fleetId])

  const enter = useCallback(
    async (path: string, email: string, password: string) => {
      const res = await api<{ accessToken: string; refreshToken: string; user: { email: string } }>(path, {
        method: 'POST',
        body: { email, password },
        auth: false,
      })
      session.set({ accessToken: res.accessToken, refreshToken: res.refreshToken, email: res.user.email })
      setEmail(res.user.email)
      // The login response does not carry verification state, so ask for it
      // rather than assuming. Assuming true would flash the whole dashboard
      // before the gate closed on it, which looks like a bug and leaks the
      // shape of an account the reader has not proven is theirs.
      const ok = await refreshMe()
      if (ok) await loadFleets()
    },
    [loadFleets, refreshMe]
  )

  const value = useMemo<AuthState>(
    () => ({
      ready,
      email,
      verified,
      fleets,
      fleet: fleets.find((f) => f.id === fleetId) ?? null,
      selectFleet: setFleetId,
      signIn: (e, p) => enter('/auth/login', e, p),
      signUp: (e, p) => enter('/auth/signup', e, p),
      signOut: () => {
        session.clear()
        setEmail(null)
        setVerified(null)
        setFleets([])
      },
      refreshFleets: loadFleets,
      refreshMe: async () => {
        const ok = await refreshMe()
        // Crossing from unverified to verified is the moment the rest of the
        // app becomes reachable, so load what it needs before handing over.
        if (ok) await loadFleets()
        return ok
      },
    }),
    [ready, email, verified, fleets, fleetId, enter, loadFleets, refreshMe]
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}

/**
 * Poll an endpoint on an interval. The dashboard has to feel live — this is a
 * product about liveness — and polling is honest about what it is rather than
 * pretending a websocket exists.
 */
export function usePoll<T>(fn: () => Promise<T>, deps: unknown[], intervalMs = 4000) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    let timer: number

    const tick = async () => {
      try {
        const next = await fn()
        if (!alive) return
        setData(next)
        setError(null)
      } catch (err) {
        if (alive) setError(err as Error)
      } finally {
        if (alive) {
          setLoading(false)
          timer = window.setTimeout(tick, intervalMs)
        }
      }
    }
    void tick()

    return () => {
      alive = false
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { data, error, loading }
}
