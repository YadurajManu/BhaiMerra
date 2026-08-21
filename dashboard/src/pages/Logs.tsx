import { useState } from 'react'
import { api, type Service } from '../lib/api'
import { useAuth, usePoll } from '../lib/auth'
import { Panel } from '../components/ui'

export default function Logs() {
  const { fleet } = useAuth(); const [serviceId, setServiceId] = useState('')
  const services = usePoll(() => api<{ services: Service[] }>(`/fleets/${fleet?.id}/services`), [fleet?.id])
  const selected = serviceId || services.data?.services[0]?.id || ''
  const logs = usePoll(() => selected ? api<{ node: { name: string }; lines: string[]; diagnostic: string | null }>(`/services/${selected}/logs`) : Promise.resolve(null), [selected], 2000)
  return <div className="space-y-6"><div><h1 className="font-mono text-[22px]">Live logs</h1><p className="mt-1 text-[14px] text-[var(--color-fg-muted)]">Bounded tails from the selected service and its current node, refreshing every two seconds.</p></div><label className="block max-w-sm font-mono text-[11px] text-[var(--color-fg-dim)]">SERVICE<select value={selected} onChange={e => setServiceId(e.target.value)} className="mt-2 block w-full border border-[var(--color-line)] bg-[var(--color-ink-900)] px-3 py-2 text-[12px] text-[var(--color-fg)]">{services.data?.services.map(s => <option value={s.id} key={s.id}>{s.name} · {s.current?.nodeName ?? 'not running'}</option>)}</select></label><Panel title={logs.data ? `tail · ${logs.data.node.name}` : 'tail'}><pre className="min-h-[360px] overflow-auto p-5 font-mono text-[11px] leading-5 text-[var(--color-fg-muted)]">{logs.data?.lines.join('\n') || logs.data?.diagnostic || 'Select a running service to view its logs.'}</pre></Panel></div>
}
