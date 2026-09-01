import { NavLink, Outlet } from 'react-router-dom'
import { api, type Service } from '../lib/api'
import { useAuth, usePoll } from '../lib/auth'
import { Logo, Dot } from './ui'

const NAV = [
  ['Overview', '/'],
  ['Nodes', '/nodes'],
  ['Services', '/services'],
  ['Events', '/events'],
  ['Alerts', '/alerts'],
  ['Doctor', '/doctor'],
  ['Logs', '/logs'],
  ['Settings', '/settings'],
] as const

export default function Shell() {
  const { email, fleets, fleet, selectFleet, signOut } = useAuth()

  // A count in the nav, so a service going down reaches you on whatever page
  // you happen to be on. Four were down for hours and the only way to find
  // out was to open Services and look.
  const services = usePoll(
    () => (fleet?.id ? api<{ services: Service[] }>(`/fleets/${fleet.id}/services`) : Promise.resolve({ services: [] })),
    [fleet?.id],
    10_000
  )
  const brokenCount = (services.data?.services ?? []).filter(
    (s) => s.current?.status !== 'running' && s.current?.status !== 'online' && s.current?.status !== 'deploying'
  ).length

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-[var(--color-line)] bg-[color-mix(in_oklab,var(--color-ink-950)_88%,transparent)] backdrop-blur-md">
        <div className="mx-auto flex h-[58px] max-w-[1400px] items-center gap-6 px-6">
          <NavLink to="/" className="shrink-0">
            <Logo size={19} word />
          </NavLink>

          {fleets.length > 0 && (
            <label className="relative">
              <span className="sr-only">Fleet</span>
              <select
                value={fleet?.id ?? ''}
                onChange={(e) => selectFleet(e.target.value)}
                className="cursor-pointer appearance-none rounded-[3px] border border-[var(--color-line)] bg-[var(--color-ink-900)] py-1.5 pl-3 pr-8 font-mono text-[11.5px] text-[var(--color-fg-muted)] outline-none transition-colors hover:border-[var(--color-line-2)]"
              >
                {fleets.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[9px] text-[var(--color-fg-dim)]">▾</span>
            </label>
          )}

          <nav className="ml-2 hidden items-center gap-1 md:flex">
            {NAV.map(([label, to]) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                className={({ isActive }) =>
                  `rounded-[3px] px-3 py-1.5 font-mono text-[11.5px] transition-colors duration-300 ${
                    isActive
                      ? 'bg-[var(--color-ink-800)] text-[var(--color-fg)]'
                      : 'text-[var(--color-fg-dim)] hover:text-[var(--color-fg-muted)]'
                  }`
                }
              >
                {label}
                {label === 'Services' && brokenCount > 0 && (
                  <span
                    title={`${brokenCount} service${brokenCount === 1 ? '' : 's'} not running`}
                    className="ml-1.5 inline-flex min-w-[15px] items-center justify-center rounded-full bg-[var(--color-down)] px-1 text-[9.5px] font-semibold text-[var(--color-ink-950)]"
                  >
                    {brokenCount}
                  </span>
                )}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-4">
            {fleet && (
              <span className="hidden items-center gap-1.5 font-mono text-[10.5px] text-[var(--color-fg-dim)] lg:flex">
                <Dot size={5} />
                {fleet.role}
              </span>
            )}
            <span className="hidden font-mono text-[10.5px] text-[var(--color-fg-dim)] sm:inline">{email}</span>
            <button
              onClick={signOut}
              className="font-mono text-[10.5px] text-[var(--color-fg-dim)] transition-colors duration-300 hover:text-[var(--color-fg)]"
            >
              sign out
            </button>
          </div>
        </div>

        {/* the nav has to exist on a phone too */}
        <nav className="no-scrollbar flex gap-1 overflow-x-auto border-t border-[var(--color-line)] px-4 py-2 md:hidden">
          {NAV.map(([label, to]) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `shrink-0 rounded-[3px] px-3 py-1.5 font-mono text-[11.5px] ${
                  isActive ? 'bg-[var(--color-ink-800)] text-[var(--color-fg)]' : 'text-[var(--color-fg-dim)]'
                }`
              }
            >
              {label}
              {label === 'Services' && brokenCount > 0 && (
                <span className="ml-1.5 inline-flex min-w-[15px] items-center justify-center rounded-full bg-[var(--color-down)] px-1 text-[9.5px] font-semibold text-[var(--color-ink-950)]">
                  {brokenCount}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-[1400px] px-6 py-8">
        <Outlet />
      </main>
    </div>
  )
}
