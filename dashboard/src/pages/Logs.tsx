import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, type Service } from '../lib/api'
import { useAuth, usePoll } from '../lib/auth'
import LogTerminal from '../components/LogTerminal'

export default function Logs() {
  const { fleet } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const paramService = searchParams.get('service') ?? ''

  const [serviceId, setServiceId] = useState(paramService)
  const [isLive, setIsLive] = useState(true)

  const services = usePoll(
    () => api<{ services: Service[] }>(`/fleets/${fleet?.id}/services`),
    [fleet?.id]
  )

  useEffect(() => {
    if (paramService) {
      setServiceId(paramService)
    }
  }, [paramService])

  const selected = serviceId || services.data?.services[0]?.id || ''
  const selectedService = services.data?.services.find((s) => s.id === selected)

  const handleSelectService = (id: string) => {
    setServiceId(id)
    setSearchParams(id ? { service: id } : {})
  }

  const logs = usePoll(
    () =>
      selected
        ? api<{ node: { name: string }; lines: string[]; diagnostic: string | null }>(
            `/services/${selected}/logs`
          )
        : Promise.resolve(null),
    [selected],
    isLive ? 2000 : 0
  )

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="font-mono text-[22px] tracking-[-0.02em]">Live Logs</h1>
        <p className="mt-1 text-[14px] text-[var(--color-fg-muted)]">
          Bounded tails from the selected service and its current node, refreshing every two seconds.
        </p>
      </div>

      {/* Service Selector */}
      <div className="flex flex-wrap items-end gap-4">
        <label className="block max-w-sm font-mono text-[11px] text-[var(--color-fg-dim)]">
          <span className="mono-label">Service</span>
          <select
            value={selected}
            onChange={(e) => handleSelectService(e.target.value)}
            className="mt-2 block w-full rounded-[3px] border border-[var(--color-line)] bg-[var(--color-ink-900)] px-3 py-2.5 text-[12px] text-[var(--color-fg)] outline-none transition-colors focus:border-[var(--color-line-2)]"
          >
            {services.data?.services.map((s) => (
              <option value={s.id} key={s.id}>
                {s.name} · {s.current?.nodeName ?? 'not running'}
              </option>
            ))}
          </select>
        </label>

        {selectedService && (
          <div className="flex items-center gap-3 font-mono text-[10.5px] text-[var(--color-fg-dim)]">
            <span>
              placement:{' '}
              <span className="text-[var(--color-fg-muted)]">{selectedService.placementPolicy}</span>
            </span>
            {selectedService.current?.status && (
              <span>
                status:{' '}
                <span className="text-[var(--color-fg-muted)]">{selectedService.current.status}</span>
              </span>
            )}
          </div>
        )}
      </div>

      {/* Log Terminal */}
      <LogTerminal
        serviceName={selectedService?.name ?? 'service'}
        nodeName={logs.data?.node?.name}
        lines={logs.data?.lines ?? []}
        diagnostic={logs.data?.diagnostic ?? null}
        loading={logs.loading}
        isLive={isLive}
        onToggleLive={() => setIsLive(!isLive)}
        height="calc(100vh - 280px)"
      />
    </div>
  )
}
