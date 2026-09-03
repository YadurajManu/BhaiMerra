import { useEffect, useRef, useState } from 'react'
import { api } from './api'

export type NodeSample = {
  at: string
  cpuPct: number | null
  /** Absent on rows written before the peak columns existed. */
  cpuMax?: number | null
  cpuMin?: number | null
  ramUsedMb: number | null
  ramMaxMb?: number | null
  diskUsedMb: number | null
  diskTotalMb: number | null
  containers: number | null
  /** Only present from agents new enough to measure them. */
  netRxKbps?: number | null
  netTxKbps?: number | null
  load1?: number | null
  tempC?: number | null
  swapUsedMb?: number | null
  dockerOk?: boolean | null
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

/** What one interval of the heartbeat strip means. */
export type Beat = 'ok' | 'missed' | 'nodata'

/**
 * Turn samples into the strip the heartbeat display draws.
 *
 * Three states, not two. Before the first sample ever recorded there is no
 * evidence either way — the control plane was not collecting yet — and drawing
 * that as a missed beat is a lie that makes a healthy node look like it has
 * been failing for an hour. Only the span between the first and last sample can
 * contain a real gap.
 */
export function beatsFrom(samples: NodeSample[], buckets = 40, windowMs = 60 * 60_000): Beat[] {
  if (!samples.length) return []

  const now = Date.now()
  const size = windowMs / buckets
  const bucketOf = (t: number) => Math.floor((windowMs - (now - t)) / size)

  const times = samples.map((s) => new Date(s.at).getTime()).filter((t) => now - t <= windowMs)
  if (!times.length) return []

  const first = bucketOf(Math.min(...times))
  const seen = new Set(times.map(bucketOf))

  return Array.from({ length: buckets }, (_, i) => {
    if (i < first) return 'nodata'
    return seen.has(i) ? 'ok' : 'missed'
  })
}

/**
 * The same strip, for whether Docker was answering.
 *
 * A node can report faithfully every five seconds while its Docker daemon is
 * dead, and the heartbeat strip would show an unbroken run of green. That is
 * the state where nothing can be deployed and everything looks fine.
 *
 * A bucket is only 'ok' when every sample in it said so: one failure inside a
 * bucket is the thing worth seeing, and averaging it away defeats the point.
 * Agents too old to report it send null, which stays 'nodata' rather than
 * becoming a claim in either direction.
 */
export function dockerBeatsFrom(
  samples: NodeSample[],
  buckets = 40,
  windowMs = 60 * 60_000
): Beat[] {
  if (!samples.length) return []

  const now = Date.now()
  const size = windowMs / buckets
  const bucketOf = (t: number) => Math.floor((windowMs - (now - t)) / size)

  const states = new Map<number, boolean>()
  let earliest = Infinity

  for (const s of samples) {
    if (s.dockerOk == null) continue
    const t = new Date(s.at).getTime()
    if (now - t > windowMs) continue
    const b = bucketOf(t)
    earliest = Math.min(earliest, b)
    states.set(b, (states.get(b) ?? true) && s.dockerOk)
  }
  if (!states.size) return []

  return Array.from({ length: buckets }, (_, i) => {
    if (i < earliest || !states.has(i)) return 'nodata'
    return states.get(i) ? 'ok' : 'missed'
  })
}
