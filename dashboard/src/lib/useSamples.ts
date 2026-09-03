import { useEffect, useRef, useState } from 'react'
import { api } from './api'

export type NodeSample = {
  at: string
  cpuPct: number | null
  ramUsedMb: number | null
  diskUsedMb: number | null
  diskTotalMb: number | null
  containers: number | null
}

type Response = {
  grain: 'fine' | 'minute' | 'hour'
  sinceMinutes: number
  samples: NodeSample[]
}

/**
 * Telemetry history for one node.
 *
 * Polled far more slowly than the node list. The list answers "is it alive",
 * which has to be current; this answers "what has it been doing", where a
 * minute of staleness on an hour-long window is invisible. Refetching it at
 * list frequency would be one query per node per few seconds for a chart whose
 * left-hand edge has not moved.
 */
export function useSamples(fleetId: string | undefined, nodeId: string, sinceMinutes = 60) {
  const [data, setData] = useState<Response | null>(null)
  const [error, setError] = useState<unknown>(null)
  // Kept in a ref so a refetch does not blank an already-drawn chart.
  const seen = useRef(false)

  useEffect(() => {
    if (!fleetId || !nodeId) return
    let alive = true

    const load = async () => {
      try {
        const r = await api<Response>(
          `/fleets/${fleetId}/nodes/${nodeId}/samples?since=${sinceMinutes}`
        )
        if (!alive) return
        setData(r)
        setError(null)
        seen.current = true
      } catch (err) {
        if (!alive) return
        // A history failure must not blank a card whose live numbers are fine.
        if (!seen.current) setError(err)
      }
    }

    void load()
    const t = setInterval(load, 60_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [fleetId, nodeId, sinceMinutes])

  return { data, error, samples: data?.samples ?? [] }
}

/**
 * Turn samples into the presence/absence strip the heartbeat display draws.
 *
 * A sample exists for every interval the node reported, so a gap in the series
 * is a gap in the beats. Bucketing by expected interval rather than counting
 * rows is what makes a two-minute outage read as two minutes rather than as one
 * missing point.
 */
export function beatsFrom(samples: NodeSample[], buckets = 40, windowMs = 60 * 60_000): boolean[] {
  if (!samples.length) return []
  const now = Date.now()
  const size = windowMs / buckets
  const seen = new Set<number>()
  for (const s of samples) {
    const age = now - new Date(s.at).getTime()
    if (age < 0 || age > windowMs) continue
    seen.add(Math.floor((windowMs - age) / size))
  }
  return Array.from({ length: buckets }, (_, i) => seen.has(i))
}
