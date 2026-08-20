import type { Redis } from 'ioredis'

export type HeartbeatPayload = {
  nodeId: string
  fleetId: string
  cpuPct: number
  ramUsedMb: number
  diskUsedMb: number
  containers: Array<{ name: string; state: string; health?: string }>
  meshConnected: boolean
  agentVersion?: string
}

/**
 * Liveness lives in Redis, not Postgres. Two structures, on purpose:
 *
 *   node:{id}:hb   a TTL key holding the last payload — O(1) "is it alive
 *                  right now, and what did it say", read by the dashboard.
 *   fleet:{id}:hb  a sorted set of nodeId → last-seen epoch ms, so the
 *                  sweeper can ask "which nodes in this fleet are stale"
 *                  in one range query instead of polling every node.
 *
 * Relying on Redis keyspace expiry events alone would be fragile: they are
 * fire-and-forget, disabled by default, and lost entirely if the control
 * plane is restarting at the moment a key expires. The sorted set makes
 * detection a pull, which survives a restart.
 */
export class HeartbeatTracker {
  constructor(
    private readonly redis: Redis,
    private readonly intervalSec: number,
    private readonly missThreshold: number
  ) {}

  /** TTL is generous by one interval so a single late packet is not a death. */
  private ttlSec(): number {
    return this.intervalSec * (this.missThreshold + 1)
  }

  /** Milliseconds of silence after which a node is considered down. */
  downAfterMs(intervalSec = this.intervalSec, threshold = this.missThreshold): number {
    return intervalSec * threshold * 1000
  }

  async record(hb: HeartbeatPayload, at = Date.now()): Promise<void> {
    const pipe = this.redis.multi()
    pipe.set(
      `node:${hb.nodeId}:hb`,
      JSON.stringify({ ...hb, at }),
      'EX',
      this.ttlSec()
    )
    pipe.zadd(`fleet:${hb.fleetId}:hb`, at, hb.nodeId)
    await pipe.exec()
  }

  async last(nodeId: string): Promise<(HeartbeatPayload & { at: number }) | null> {
    const raw = await this.redis.get(`node:${nodeId}:hb`)
    return raw ? JSON.parse(raw) : null
  }

  /** Node ids in this fleet that have not been heard from recently enough. */
  async staleNodes(
    fleetId: string,
    opts: { intervalSec: number; threshold: number },
    now = Date.now()
  ): Promise<string[]> {
    const cutoff = now - this.downAfterMs(opts.intervalSec, opts.threshold)
    return this.redis.zrangebyscore(`fleet:${fleetId}:hb`, '-inf', cutoff)
  }

  /** Node ids that are currently healthy. */
  async liveNodes(
    fleetId: string,
    opts: { intervalSec: number; threshold: number },
    now = Date.now()
  ): Promise<string[]> {
    const cutoff = now - this.downAfterMs(opts.intervalSec, opts.threshold)
    return this.redis.zrangebyscore(`fleet:${fleetId}:hb`, `(${cutoff}`, '+inf')
  }

  /** Called when a node is deliberately removed, so it stops being swept. */
  async forget(fleetId: string, nodeId: string): Promise<void> {
    await this.redis.multi().del(`node:${nodeId}:hb`).zrem(`fleet:${fleetId}:hb`, nodeId).exec()
  }
}
