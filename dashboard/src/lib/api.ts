export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly detail?: unknown) {
    super(message)
  }
}

const BASE = import.meta.env.VITE_API ?? '/api'
const STORE = 'fleet-os.session'

export type Session = { accessToken: string; refreshToken: string; email?: string }

export const session = {
  get(): Session | null {
    try {
      const raw = localStorage.getItem(STORE)
      return raw ? (JSON.parse(raw) as Session) : null
    } catch {
      return null
    }
  },
  set(s: Session) {
    localStorage.setItem(STORE, JSON.stringify(s))
  },
  clear() {
    localStorage.removeItem(STORE)
  },
}

let refreshing: Promise<string | null> | null = null

/**
 * Refresh once, shared. Six panels polling at once would otherwise each fire
 * their own refresh on the same expiry, and since refresh tokens are single
 * use, all but the first would fail and log the user out.
 */
async function refreshAccessToken(): Promise<string | null> {
  if (refreshing) return refreshing
  const current = session.get()
  if (!current?.refreshToken) return null

  refreshing = (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      })
      if (!res.ok) {
        session.clear()
        return null
      }
      const tokens = (await res.json()) as { accessToken: string; refreshToken: string }
      session.set({ ...current, ...tokens })
      return tokens.accessToken
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; auth?: boolean; signal?: AbortSignal } = {}
): Promise<T> {
  const send = async (token?: string) =>
    fetch(BASE + path, {
      method: opts.method ?? 'GET',
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(opts.body ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    })

  const needsAuth = opts.auth !== false
  let res = await send(needsAuth ? session.get()?.accessToken : undefined)

  if (res.status === 401 && needsAuth) {
    const fresh = await refreshAccessToken()
    if (fresh) res = await send(fresh)
  }

  const text = await res.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }

  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string; detail?: unknown } })?.error
    throw new ApiError(res.status, err?.code ?? 'unknown', err?.message ?? `Request failed (${res.status})`, err?.detail)
  }
  return body as T
}

/* ── shapes the dashboard reads ─────────────────────────────────── */

export type Fleet = {
  id: string
  name: string
  orgId: string
  role: 'owner' | 'admin' | 'deployer' | 'viewer'
  defaultReclaimPolicy: string
  heartbeatIntervalSec: number
  heartbeatMissThreshold: number
}

export type Node = {
  id: string
  name: string
  arch: string
  os: string
  status: 'online' | 'offline' | 'cordoned' | 'draining'
  cpuCores: number
  ramMb: number
  diskMb: number
  hasGpu: boolean
  reliabilityTier: 'opportunistic' | 'standard' | 'high'
  tags: string[]
  live: boolean
  lastHeartbeatAt: string | null
  advertiseAddr: string | null
  agentVersion: string | null
  createdAt: string
  telemetry: {
    cpuPct: number
    ramUsedMb: number
    diskUsedMb: number
    meshConnected: boolean
    ageMs: number
    containers: Array<{ name: string; state: string; health?: string }>
    runtime: { dockerAvailable: boolean; dockerVersion?: string; dockerApiVersion?: string; dockerError?: string; registryStatus?: 'ok' | 'failed' | 'not_tested'; registryError?: string; lastReconcileError?: string }
  } | null
}

export type Service = {
  id: string
  name: string
  /** The manifest these services came from; the dashboard groups by it. */
  project: string
  repoUrl: string | null
  placementPolicy: 'pinned' | 'preferred' | 'flexible'
  pinnedNodeId: string | null
  requestRamMb: number
  requiresGpu: boolean
  persistentVolume: boolean
  volumeName: string | null
  hostname: string | null
  domain: string | null
  replicas: number
  minReliabilityTier: string
  compatibleArches: string[]
  current: { nodeId: string | null; nodeName: string | null; status: string; gitSha: string | null } | null
  /**
   * The most recent deployment whatever its outcome, so a service that is not
   * running can still say what happened to it and when. `current` is null in
   * exactly that case, which is why it cannot answer this on its own.
   */
  last: {
    status: string
    failureReason: string | null
    startedAt: string
    finishedAt: string | null
    nodeName: string | null
    gitSha: string | null
  } | null
}

export type PlacementMapNode = {
  id: string
  name: string
  arch: string
  status: string
  reliabilityTier: string
  ramMb: number
  freeRamMb: number
  loadFactor: number | null
  services: Array<{ name: string; policy: string; status: string }>
}

export type TimelineEvent = {
  at: string
  service: string
  reason: string
  from: string | null
  to: string | null
  detail: Record<string, unknown> | null
}

export type AlertRule = {
  id: string
  channelType: string
  eventTypes: string[]
  enabled: boolean
  target: string
}

export type Deployment = {
  id: string
  gitSha: string | null
  status: string
  nodeName: string | null
  startedAt: string
  finishedAt: string | null
  failureReason: string | null
  imageTags: string[]
}

export type AuditEntry = {
  id: string
  action: string
  actorKind: string
  targetType: string
  targetId: string | null
  metadata: Record<string, unknown> | null
  createdAt: string
}
