import { useEffect, useRef, useState } from 'react'
import { useReducedMotion } from 'framer-motion'
import Reveal from './ui/Reveal'
import SectionHead from './ui/SectionHead'
import StatusDot from './ui/StatusDot'

// kind: cmd (typed), out, ok, dim, warn, blank
const SCRIPT = [
  { kind: 'cmd', text: 'fleet init' },
  { kind: 'ok', text: '  ✓ wrote fleet.yaml' },
  { kind: 'ok', text: '  ✓ linked github.com/you/homelab' },
  { kind: 'dim', text: '  fleet: homelab · 4 nodes · 3 architectures' },
  { kind: 'blank' },
  { kind: 'cmd', text: 'cat fleet.yaml' },
  { kind: 'out', text: 'services:' },
  { kind: 'out', text: '  web:' },
  { kind: 'out', text: '    build: ./apps/web' },
  { kind: 'out', text: '    placement: flexible' },
  { kind: 'out', text: '    resources: { ram: 512Mi, cpu: 0.5 }' },
  { kind: 'out', text: '    domain: web.yourdomain.dev' },
  { kind: 'out', text: '  postgres:' },
  { kind: 'out', text: '    image: postgres:16' },
  { kind: 'out', text: '    placement: pinned' },
  { kind: 'out', text: '    node: node-03' },
  { kind: 'out', text: '    volume: pgdata' },
  { kind: 'blank' },
  { kind: 'cmd', text: 'git push fleet main' },
  { kind: 'dim', text: 'remote: build 4f1c9ae · buildx · linux/arm64 linux/amd64' },
  { kind: 'dim', text: 'remote: layers cached 11/14 · 38.2s' },
  { kind: 'dim', text: 'remote: pushed registry.fleet-os.dev/homelab/web:4f1c9ae' },
  { kind: 'ok', text: 'remote: schedule web → node-01 home-server (score 0.92)' },
  { kind: 'ok', text: 'remote: health   GET /healthz  200  1.9s' },
  { kind: 'ok', text: 'remote: live     https://web.yourdomain.dev' },
  { kind: 'out', text: '   9ac21bd..4f1c9ae  main -> main' },
  { kind: 'blank' },
  { kind: 'cmd', text: 'fleet status' },
  { kind: 'dim', text: 'NODE     HOST          ARCH   SVC  LOAD  STATUS' },
  { kind: 'out', text: 'node-01  home-server   amd64   2    38%  online' },
  { kind: 'out', text: 'node-02  pi-5          arm64   1    48%  online' },
  { kind: 'out', text: 'node-03  thinkpad      amd64   1    41%  online' },
  { kind: 'out', text: 'node-04  vps-fra       amd64   1    22%  online' },
]

const COLOR = {
  cmd: 'var(--color-fg)',
  out: 'var(--color-fg-muted)',
  ok: 'var(--color-signal)',
  dim: 'var(--color-fg-dim)',
  warn: 'var(--color-warn)',
}

const CLI = [
  ['fleet nodes', 'list, cordon, drain, remove'],
  ['fleet deploy', 'trigger a deploy at a git sha'],
  ['fleet logs -f', 'follow logs across every node'],
  ['fleet rollback', 'previous deployment, same node rules'],
  ['fleet reschedule', 'force a service to move'],
]

const API = [
  ['POST', '/fleets/:id/nodes/pair-token'],
  ['POST', '/services/:id/deploy'],
  ['POST', '/deployments/:id/rollback'],
  ['GET', '/fleets/:id/placement-map'],
  ['GET', '/fleets/:id/events'],
]

function useTypedScript(active) {
  const reduce = useReducedMotion()
  const [lines, setLines] = useState([])
  const [partial, setPartial] = useState(null)
  const [done, setDone] = useState(false)
  const timers = useRef([])

  useEffect(() => {
    if (!active) return
    if (reduce) {
      setLines(SCRIPT)
      setDone(true)
      return
    }

    let i = 0
    const push = (fn, ms) => timers.current.push(setTimeout(fn, ms))

    const step = () => {
      if (i >= SCRIPT.length) {
        setDone(true)
        return
      }
      const l = SCRIPT[i]

      if (l.kind === 'cmd') {
        let c = 0
        const type = () => {
          c += 1
          setPartial(l.text.slice(0, c))
          if (c < l.text.length) push(type, 16 + Math.random() * 26)
          else
            push(() => {
              setPartial(null)
              setLines((p) => [...p, l])
              i += 1
              step()
            }, 260)
        }
        push(type, 220)
      } else {
        setLines((p) => [...p, l])
        i += 1
        push(step, l.kind === 'blank' ? 60 : 42)
      }
    }

    push(step, 260)
    return () => {
      timers.current.forEach(clearTimeout)
      timers.current = []
    }
  }, [active, reduce])

  return { lines, partial, done }
}

export default function Terminal() {
  const ref = useRef(null)
  const bodyRef = useRef(null)
  const [active, setActive] = useState(false)
  const { lines, partial, done } = useTypedScript(active)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setActive(true), {
      threshold: 0.25,
    })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [lines, partial])

  return (
    <section id="cli" className="relative border-b border-[var(--color-line)]">
      <div className="rail py-24 lg:py-32">
        <SectionHead
          index="05"
          kicker="cli and api"
          title="Nothing the dashboard does is unavailable from a shell."
          max="max-w-[26ch]"
        />

        <div className="mt-14 grid gap-8 lg:grid-cols-12">
          {/* terminal */}
          <Reveal amount={0.15} className="lg:col-span-8">
            <div ref={ref} className="border border-[var(--color-line)] bg-[#07080a] shadow-[0_40px_80px_-40px_rgba(0,0,0,0.9)]">
              <div className="flex items-center justify-between border-b border-[var(--color-line)] bg-[var(--color-ink-900)] px-4 py-2.5">
                <div className="flex items-center gap-2 font-mono text-[10.5px] text-[var(--color-fg-dim)]">
                  <StatusDot tone={done ? 'online' : 'idle'} size={5} />
                  zsh — ~/homelab
                </div>
                <span className="font-mono text-[10px] tracking-[0.1em] text-[var(--color-fg-dim)]">
                  fleet-os cli v0.9.2
                </span>
              </div>

              <div
                ref={bodyRef}
                className="h-[430px] overflow-y-auto px-5 py-4 font-mono text-[12px] leading-[1.75] sm:h-[490px]"
              >
                {lines.map((l, i) =>
                  l.kind === 'blank' ? (
                    <div key={i} className="h-3.5" />
                  ) : (
                    <div key={i} className="whitespace-pre" style={{ color: COLOR[l.kind] }}>
                      {l.kind === 'cmd' && <span className="text-[var(--color-signal)]">❯ </span>}
                      {l.text}
                    </div>
                  )
                )}
                {partial !== null && (
                  <div className="whitespace-pre text-[var(--color-fg)]">
                    <span className="text-[var(--color-signal)]">❯ </span>
                    {partial}
                    <span className="caret ml-[1px] align-middle" />
                  </div>
                )}
                {done && (
                  <div className="whitespace-pre text-[var(--color-fg)]">
                    <span className="text-[var(--color-signal)]">❯ </span>
                    <span className="caret align-middle" />
                  </div>
                )}
              </div>
            </div>
          </Reveal>

          {/* reference rails */}
          <div className="lg:col-span-4">
            <Reveal i={1} className="border border-[var(--color-line)] bg-[var(--color-ink-900)] p-6">
              <span className="mono-label">cli</span>
              <ul className="mt-4 space-y-3.5">
                {CLI.map(([cmd, note]) => (
                  <li key={cmd}>
                    <div className="font-mono text-[12px] text-[var(--color-fg)]">{cmd}</div>
                    <div className="mt-0.5 text-[11.5px] text-[var(--color-fg-dim)]">{note}</div>
                  </li>
                ))}
              </ul>
            </Reveal>

            <Reveal i={2} className="mt-6 border border-[var(--color-line)] bg-[var(--color-ink-900)] p-6">
              <span className="mono-label">rest api</span>
              <ul className="mt-4 space-y-2.5">
                {API.map(([m, path]) => (
                  <li key={path} className="flex items-baseline gap-2.5 font-mono text-[11px]">
                    <span
                      className="w-9 shrink-0 text-[10px] tracking-[0.06em]"
                      style={{ color: m === 'GET' ? 'var(--color-fg-dim)' : 'var(--color-signal)' }}
                    >
                      {m}
                    </span>
                    <span className="truncate text-[var(--color-fg-muted)]">{path}</span>
                  </li>
                ))}
              </ul>
              <a
                href="#"
                className="link-draw mt-5 inline-block font-mono text-[11px] text-[var(--color-fg-muted)] transition-colors duration-300 hover:text-[var(--color-signal)]"
              >
                full api reference ↗
              </a>
            </Reveal>
          </div>
        </div>
      </div>
    </section>
  )
}
