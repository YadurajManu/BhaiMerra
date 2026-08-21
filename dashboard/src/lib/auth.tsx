import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, session, type Fleet } from './api'

type Me = { user: { id: string; email: string }; orgs: Array<{ orgName: string; role: string; plan: string }> }

type AuthState = {
  ready: boolean
  email: string | null
  fleets: Fleet[]
  fleet: Fleet | null
  selectFleet: (id: string) => void
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string) => Promise<void>
  signOut: () => void
  refreshFleets: () => Promise<void>
}

const Ctx = createContext<AuthState | null>(null)
const LAST_FLEET = 'fleet-os.fleet'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [email, setEmail] = useState<string | null>(null)
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

  const bootstrap = useCallback(async () => {
    if (!session.get()?.accessToken) {
      setReady(true)
      return
    }
    try {
      const me = await api<Me>('/auth/me')
      setEmail(me.user.email)
      await loadFleets()
    } catch {
      session.clear()
      setEmail(null)
    } finally {
      setReady(true)
    }
  }, [loadFleets])

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
      await loadFleets()
    },
    [loadFleets]
  )

  const value = useMemo<AuthState>(
    () => ({
      ready,
      email,
      fleets,
      fleet: fleets.find((f) => f.id === fleetId) ?? null,
      selectFleet: setFleetId,
      signIn: (e, p) => enter('/auth/login', e, p),
      signUp: (e, p) => enter('/auth/signup', e, p),
      signOut: () => {
        session.clear()
        setEmail(null)
        setFleets([])
      },
      refreshFleets: loadFleets,
    }),
    [ready, email, fleets, fleetId, enter, loadFleets]
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
