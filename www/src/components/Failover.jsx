import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { EASE } from '../lib/motion'
import SectionHead from './ui/SectionHead'
import Reveal from './ui/Reveal'
import StatusDot from './ui/StatusDot'

const NODES = [
  { id: 'n1', name: 'node-01', host: 'home-server', arch: 'amd64', tier: 'always-on', load: 0.34 },
  { id: 'n2', name: 'node-02', host: 'pi-5', arch: 'arm64', tier: 'always-on', load: 0.48 },
  { id: 'n3', name: 'node-03', host: 'thinkpad', arch: 'amd64', tier: 'intermittent', load: 0.41 },
  { id: 'n4', name: 'node-04', host: 'vps-fra', arch: 'amd64', tier: 'burst', load: 0.22 },
]

const SERVICES = [
  { id: 'web', name: 'web', policy: 'flexible', home: 'n1' },
  { id: 'cache', name: 'cache', policy: 'flexible', home: 'n1' },
  { id: 'grafana', name: 'grafana', policy: 'flexible', home: 'n2' },
  { id: 'imgproxy', name: 'img-proxy', policy: 'flexible', home: 'n3' },
  { id: 'postgres', name: 'postgres', policy: 'pinned', home: 'n3' },
  { id: 'worker', name: 'worker', policy: 'flexible', home: 'n4' },
]

const HOME = Object.fromEntries(SERVICES.map((s) => [s.id, s.home]))

// `at` drives the animation; `ts` drives the printed clock. They differ on
// purpose: the sequence is compressed for viewing, the log stays truthful to a
// 5s heartbeat interval.
const stamp = (ms, base = 14 * 3600 + 2 * 60 + 11) => {
  const total = base + ms / 1000
  const h = String(Math.floor(total / 3600)).padStart(2, '0')
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
  const s = (total % 60).toFixed(3).padStart(6, '0')
  return `${h}:${m}:${s}`
}

const FAIL_SCRIPT = [
  { at: 0, ts: 0, kind: 'hb', text: 'heartbeat  node-03  missed 1/3' },
  { at: 900, ts: 5000, kind: 'hb', text: 'heartbeat  node-03  missed 2/3', missed: 2 },
  { at: 1800, ts: 10000, kind: 'hb', text: 'heartbeat  node-03  missed 3/3', missed: 3 },
  { at: 2350, ts: 10042, kind: 'down', text: 'node       node-03  → down · 15.0s since last contact', down: true },
  {
    at: 2900,
    ts: 10515,
    kind: 'ok',
    text: 'schedule   img-proxy  flexible · eligible 3/3 → node-01 (score 0.92)',
    move: ['imgproxy', 'n1'],
  },
  {
    at: 3250,
    ts: 10604,
    kind: 'warn',
    text: 'alert      postgres   PINNED · not rescheduled · webhook + discord',
    alert: true,
  },
  { at: 4400, ts: 14620, kind: 'ok', text: 'deploy     img-proxy  running on node-01 · 4.1s total' },
]

// node-03 comes back nine minutes later
const BACK_BASE = 14 * 3600 + 11 * 60 + 4

const BACK_SCRIPT = [
  { at: 0, ts: 0, kind: 'ok', text: 'node       node-03  → online · reclaim policy = idle', down: false },
  { at: 700, ts: 118, kind: 'dim', text: 'schedule   img-proxy  stays on node-01 · no churn' },
  { at: 1400, ts: 1946, kind: 'ok', text: 'deploy     postgres   resumed on node-03', alert: false },
]

const TONE = {
  hb: 'var(--color-fg-dim)',
  down: 'var(--color-down)',
  ok: 'var(--color-signal)',
  warn: 'var(--color-warn)',
  dim: 'var(--color-fg-dim)',
}

function ServiceChip({ svc, alerting, down }) {
  const pinned = svc.policy === 'pinned'
  const state = down && pinned ? 'warn' : down ? 'down' : 'ok'

  return (
    <motion.div
      layout
      layoutId={`chip-${svc.id}`}
      transition={{ type: 'spring', stiffness: 260, damping: 30, mass: 0.7 }}
      className={`flex items-center gap-2 border px-2.5 py-1.5 font-mono text-[10.5px] ${
        alerting && pinned
          ? 'border-[color-mix(in_oklab,var(--color-warn)_50%,var(--color-line))] bg-[color-mix(in_oklab,var(--color-warn)_10%,transparent)] text-[var(--color-warn)]'
          : 'border-[var(--color-line-2)] bg-[var(--color-ink-850)] text-[var(--color-fg-muted)]'
      }`}
    >
      <StatusDot tone={alerting && pinned ? 'warn' : state === 'ok' ? 'online' : 'idle'} size={5} />
      {svc.name}
      <span className="text-[9px] tracking-[0.08em] text-[var(--color-fg-dim)]">
        {pinned ? 'pinned' : 'flex'}
      </span>
    </motion.div>
  )
}

export default function Failover() {
  const reduce = useReducedMotion()
  const [placement, setPlacement] = useState(HOME)
  const [down, setDown] = useState(false)
  const [missed, setMissed] = useState(0)
  const [alert, setAlert] = useState(false)
  const [log, setLog] = useState([])
  const [running, setRunning] = useState(false)
  const timers = useRef([])
  const reduceRef = useRef(false)
  const sectionRef = useRef(null)
  const playedOnce = useRef(false)
  const logRef = useRef(null)

  reduceRef.current = !!reduce

  const clear = () => {
    timers.current.forEach(clearTimeout)
    timers.current = []
  }

  const run = useCallback((script, resetLog, base) => {
    clear()
    setRunning(true)
    if (resetLog) setLog([])
    script.forEach((ev) => {
      timers.current.push(
        setTimeout(() => {
          if (ev.missed !== undefined) setMissed(ev.missed)
          if (ev.down !== undefined) setDown(ev.down)
          if (ev.alert !== undefined) setAlert(ev.alert)
          if (ev.move) setPlacement((p) => ({ ...p, [ev.move[0]]: ev.move[1] }))
          setLog((l) => [...l, { t: stamp(ev.ts, base), kind: ev.kind, text: ev.text }])
        }, reduceRef.current ? 0 : ev.at)
      )
    })
    const last = script[script.length - 1].at
    timers.current.push(setTimeout(() => setRunning(false), reduceRef.current ? 0 : last + 200))
  }, [])

  const fail = () => {
    setPlacement(HOME)
    setMissed(1)
    setAlert(false)
    run(FAIL_SCRIPT, true)
  }

  const restore = () => {
    setMissed(0)
    run(BACK_SCRIPT, false, BACK_BASE)
  }

  const reset = () => {
    clear()
    setPlacement(HOME)
    setDown(false)
    setMissed(0)
    setAlert(false)
    setLog([])
    setRunning(false)
  }

  // Play once, unprompted, the first time the diagram is actually on screen.
  useEffect(() => {
    const el = sectionRef.current
    if (!el) return
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting && !playedOnce.current) {
          playedOnce.current = true
          fail()
        }
      },
      { threshold: 0.4 }
    )
    io.observe(el)
    return () => {
      io.disconnect()
      clear()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  const byNode = useMemo(() => {
    const m = Object.fromEntries(NODES.map((n) => [n.id, []]))
    SERVICES.forEach((s) => m[placement[s.id]].push(s))
    return m
  }, [placement])

  return (
    <section id="failover" ref={sectionRef} className="relative border-b border-[var(--color-line)]">
      <div className="rail py-24 lg:py-32">
        <div className="grid gap-10 lg:grid-cols-12">
          <div className="lg:col-span-6">
            <SectionHead
              index="03"
              kicker="the part that matters"
              title="A laptop closing its lid is a scheduling event."
              max="max-w-[20ch]"
            />
          </div>
          <Reveal i={2} className="self-end lg:col-span-5 lg:col-start-8">
            <p className="text-[14.5px] leading-[1.7] text-[var(--color-fg-muted)] text-pretty">
              Three missed heartbeats and the node is out of the eligible set. Flexible
              services get re-placed on whatever else can run them. Pinned services —
              the database, the thing with the volume attached — deliberately do not
              move, and raise their own alert instead. Watch the difference.
            </p>
          </Reveal>
        </div>

        {/* ── the diagram ───────────────────────────────────────────── */}
        <Reveal i={0} amount={0.15} className="mt-14 border border-[var(--color-line)] bg-[var(--color-ink-900)]">
          {/* control bar */}
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-line)] px-5 py-3.5">
            <div className="flex items-center gap-3 font-mono text-[10.5px] tracking-[0.1em] text-[var(--color-fg-dim)]">
              <span className="uppercase">fleet: homelab</span>
              <span className="text-[var(--color-line-2)]">│</span>
              <span className="flex items-center gap-1.5">
                <StatusDot tone={down ? 'warn' : 'online'} size={5} />
                {down ? '3 of 4 nodes online' : '4 of 4 nodes online'}
              </span>
              {missed > 0 && !down && (
                <span className="text-[var(--color-warn)]">heartbeat {missed}/3</span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={fail}
                disabled={running}
                className="border border-[var(--color-line-2)] px-3 py-1.5 font-mono text-[10.5px] text-[var(--color-fg-muted)] transition-colors duration-300 hover:border-[var(--color-down)] hover:text-[var(--color-down)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                kill node-03
              </button>
              <button
                onClick={restore}
                disabled={running || !down}
                className="border border-[var(--color-line-2)] px-3 py-1.5 font-mono text-[10.5px] text-[var(--color-fg-muted)] transition-colors duration-300 hover:border-[var(--color-signal)] hover:text-[var(--color-signal)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                bring it back
              </button>
              <button
                onClick={reset}
                className="px-2 py-1.5 font-mono text-[10.5px] text-[var(--color-fg-dim)] transition-colors duration-300 hover:text-[var(--color-fg)]"
              >
                reset
              </button>
            </div>
          </div>

          <div className="grid lg:grid-cols-[1fr_auto]">
            {/* placement map */}
            <div className="grid gap-px bg-[var(--color-line)] sm:grid-cols-2">
              {NODES.map((n) => {
                const isDown = down && n.id === 'n3'
                return (
                  <div
                    key={n.id}
                    className="relative min-h-[168px] bg-[var(--color-ink-950)] p-5 transition-colors duration-500"
                    style={isDown ? { background: 'color-mix(in oklab, var(--color-down) 5%, var(--color-ink-950))' } : undefined}
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-2 font-mono text-[12px] text-[var(--color-fg)]">
                          <StatusDot tone={isDown ? 'down' : 'online'} size={6} />
                          {n.name}
                          <span className="text-[var(--color-fg-dim)]">{n.host}</span>
                        </div>
                        <div className="mt-1.5 pl-[14px] font-mono text-[9.5px] tracking-[0.08em] text-[var(--color-fg-dim)]">
                          {n.arch} · {n.tier}
                        </div>
                      </div>
                      <span
                        className="font-mono text-[9.5px] uppercase tracking-[0.12em]"
                        style={{ color: isDown ? 'var(--color-down)' : 'var(--color-fg-dim)' }}
                      >
                        {isDown ? 'down' : 'online'}
                      </span>
                    </div>

                    {/* load meter */}
                    <div className="mt-4 h-[2px] w-full bg-[var(--color-line)]">
                      <motion.div
                        className="h-full"
                        animate={{
                          scaleX: isDown ? 0 : n.load + (n.id === 'n1' && placement.imgproxy === 'n1' ? 0.14 : 0),
                        }}
                        transition={{ duration: 0.8, ease: EASE.expo }}
                        style={{ transformOrigin: 'left', background: 'var(--color-signal-dim)' }}
                      />
                    </div>

                    <div className="mt-4 flex flex-wrap gap-1.5">
                      {byNode[n.id].map((s) => (
                        <ServiceChip key={s.id} svc={s} alerting={alert} down={isDown} />
                      ))}
                      {byNode[n.id].length === 0 && (
                        <span className="font-mono text-[10px] text-[var(--color-fg-dim)]">no workloads</span>
                      )}
                    </div>

                    {isDown && (
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="pointer-events-none absolute inset-0"
                        style={{
                          backgroundImage:
                            'repeating-linear-gradient(45deg, transparent 0 7px, rgba(255,95,82,0.05) 7px 8px)',
                        }}
                      />
                    )}
                  </div>
                )
              })}
            </div>

            {/* event log */}
            <div className="border-t border-[var(--color-line)] bg-[var(--color-ink-900)] lg:w-[400px] lg:border-l lg:border-t-0 xl:w-[460px]">
              <div className="border-b border-[var(--color-line)] px-5 py-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-dim)]">
                control plane · events
              </div>
              <div ref={logRef} className="h-[240px] overflow-y-auto px-5 py-3 lg:h-[calc(100%-38px)]">
                {log.length === 0 && (
                  <div className="font-mono text-[11px] text-[var(--color-fg-dim)]">
                    waiting for events… <span className="caret align-middle" />
                  </div>
                )}
                {log.map((l, i) => (
                  <motion.div
                    key={`${i}-${l.t}`}
                    initial={reduce ? { opacity: 0 } : { opacity: 0, x: -6 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.35, ease: EASE.expo }}
                    className="flex gap-3 py-[3px] font-mono text-[10.5px] leading-[1.55]"
                  >
                    <span className="shrink-0 text-[var(--color-fg-dim)]">{l.t}</span>
                    <span className="whitespace-pre-wrap" style={{ color: TONE[l.kind] }}>
                      {l.text}
                    </span>
                  </motion.div>
                ))}
              </div>
            </div>
          </div>

          {/* legend — the distinction, stated once */}
          <div className="grid gap-px border-t border-[var(--color-line)] bg-[var(--color-line)] sm:grid-cols-2">
            <div className="bg-[var(--color-ink-900)] px-5 py-4">
              <div className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-[var(--color-signal)]">
                <StatusDot size={5} /> flexible
              </div>
              <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--color-fg-muted)]">
                Stateless, arch-portable, safe to move. Re-placed automatically on the
                highest-scoring eligible node. Typically live again in seconds.
              </p>
            </div>
            <div className="bg-[var(--color-ink-900)] px-5 py-4">
              <div className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-[var(--color-warn)]">
                <StatusDot tone="warn" size={5} /> pinned
              </div>
              <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--color-fg-muted)]">
                Bound to a node — a volume, a USB device, a licence. Never silently
                relocated. You get a distinct alert saying exactly which pinned service
                is down and why it stayed put.
              </p>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
