import { motion } from 'framer-motion'
import { EASE } from '../lib/motion'

const row = (i) => ({
  initial: { opacity: 0, x: -8 },
  animate: { opacity: 1, x: 0 },
  transition: { duration: 0.5, delay: 0.08 + i * 0.09, ease: EASE.expo },
})

function Frame({ title, children, right }) {
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden border border-[var(--color-line)] bg-[var(--color-ink-900)]">
      <div className="flex items-center justify-between border-b border-[var(--color-line)] px-4 py-2.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-dim)]">
          {title}
        </span>
        {right && <span className="font-mono text-[10px] text-[var(--color-fg-dim)]">{right}</span>}
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-center p-4 sm:p-5">{children}</div>
    </div>
  )
}

/* 01 — register */
function Register() {
  const caps = [
    ['arch', 'arm64'],
    ['cpu_cores', '4'],
    ['ram_mb', '8192'],
    ['disk_mb', '119000'],
    ['gpu', 'false'],
    ['connectivity', 'nat'],
  ]
  return (
    <Frame title="agent · first contact" right="node-02">
      <div className="min-w-0 font-mono text-[11px] leading-[1.9] sm:text-[11.5px]">
        <motion.div {...row(0)} className="break-all text-[var(--color-fg-muted)]">
          <span className="text-[var(--color-signal)]">$</span> curl -fsSL fleet-os.dev/install | sh
        </motion.div>
        <motion.div {...row(1)} className="text-[var(--color-fg-dim)]">
          → detecting capability…
        </motion.div>
        <div className="mt-3 grid grid-cols-1 gap-x-6 sm:grid-cols-2">
          {caps.map(([k, v], i) => (
            <motion.div key={k} {...row(2 + i * 0.5)} className="flex justify-between border-b border-dashed border-[var(--color-line)] py-1">
              <span className="text-[var(--color-fg-dim)]">{k}</span>
              <span className="text-[var(--color-fg)]">{v}</span>
            </motion.div>
          ))}
        </div>
        <motion.div {...row(6)} className="mt-3 break-words text-[var(--color-signal)]">
          ✓ registered · fleet=homelab · tier=always-on
        </motion.div>
      </div>
    </Frame>
  )
}

/* 02 — build */
function Build() {
  const targets = [
    ['linux/arm64', 'pi 5, mini pc'],
    ['linux/arm/v7', 'pi zero 2 w'],
    ['linux/amd64', 'thinkpad, vps'],
  ]
  return (
    <Frame title="buildx · multi-arch" right="sha 4f1c9ae">
      <div className="min-w-0 space-y-3 font-mono text-[11px] sm:text-[11.5px]">
        {targets.map(([t, who], i) => (
          <motion.div key={t} {...row(i)} className="border border-[var(--color-line)] bg-[var(--color-ink-850)] p-3">
            <div className="flex items-center justify-between">
              <span className="text-[var(--color-fg)]">{t}</span>
              <motion.span
                initial={{ opacity: 0, scale: 0.7 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.5 + i * 0.28, duration: 0.4, ease: EASE.snap }}
                className="text-[var(--color-signal)]"
              >
                ✓ pushed
              </motion.span>
            </div>
            <div className="mt-2 h-[3px] w-full overflow-hidden bg-[var(--color-line)]">
              <motion.div
                initial={{ scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ delay: 0.15 + i * 0.28, duration: 0.5, ease: EASE.glide }}
                style={{ transformOrigin: 'left' }}
                className="h-full bg-[var(--color-signal-dim)]"
              />
            </div>
            <div className="mt-2 text-[10px] text-[var(--color-fg-dim)]">runs on {who}</div>
          </motion.div>
        ))}
      </div>
    </Frame>
  )
}

/* 03 — place */
function Place() {
  const nodes = [
    { n: 'node-01 home-server', ok: true, score: 0.92, why: 'amd64 · 11.2GB free' },
    { n: 'node-04 vps-fra', ok: true, score: 0.61, why: 'amd64 · 1.4GB free' },
    { n: 'node-02 pi-5', ok: true, score: 0.44, why: 'arm64 · 5.9GB free' },
    { n: 'node-05 pi-zero', ok: false, why: 'armv7 · ram below request' },
    { n: 'node-03 thinkpad', ok: false, why: 'reliability tier below min' },
  ]
  return (
    <Frame title="scheduler · placement" right="svc: img-proxy">
      <div className="min-w-0 space-y-1.5 font-mono text-[10.5px] sm:text-[11px]">
        {nodes.map((n, i) => (
          <motion.div
            key={n.n}
            {...row(i)}
            className={`flex items-center gap-3 border-l-2 py-1.5 pl-3 ${
              i === 0
                ? 'border-[var(--color-signal)] bg-[color-mix(in_oklab,var(--color-signal)_7%,transparent)]'
                : n.ok
                  ? 'border-[var(--color-line-2)]'
                  : 'border-transparent opacity-45'
            }`}
          >
            <span
              className={`w-[112px] shrink-0 truncate sm:w-[152px] ${
                n.ok ? 'text-[var(--color-fg)]' : 'text-[var(--color-fg-dim)] line-through'
              }`}
            >
              {n.n}
            </span>
            <span className="hidden min-w-0 flex-1 truncate text-[10px] text-[var(--color-fg-dim)] sm:block">{n.why}</span>
            {n.ok && (
              <span className="flex items-center gap-2">
                <span className="h-[3px] w-12 bg-[var(--color-line)]">
                  <motion.span
                    initial={{ scaleX: 0 }}
                    animate={{ scaleX: n.score }}
                    transition={{ delay: 0.35 + i * 0.1, duration: 0.6, ease: EASE.expo }}
                    style={{ transformOrigin: 'left' }}
                    className="block h-full bg-[var(--color-signal)]"
                  />
                </span>
                <span className="w-8 text-right text-[10px] text-[var(--color-fg-muted)]">
                  {n.score.toFixed(2)}
                </span>
              </span>
            )}
          </motion.div>
        ))}
        <motion.div {...row(6)} className="pt-2 text-[var(--color-signal)]">
          → placed on node-01
        </motion.div>
      </div>
    </Frame>
  )
}

/* 04 — mesh */
function Mesh() {
  const pts = [
    [22, 30], [58, 18], [50, 52], [82, 40], [30, 68],
  ]
  const links = [[0, 2], [2, 1], [2, 3], [0, 4], [4, 2], [1, 3]]
  return (
    <Frame title="mesh · wireguard peers" right="fleet-scoped">
      <div className="relative h-full min-h-[190px]">
        <svg viewBox="0 0 100 80" className="h-full w-full">
          {links.map(([a, b], i) => (
            <motion.line
              key={i}
              x1={pts[a][0]} y1={pts[a][1]} x2={pts[b][0]} y2={pts[b][1]}
              stroke="#3a444f" strokeWidth="0.4"
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 1 }}
              transition={{ delay: 0.1 + i * 0.07, duration: 0.5, ease: EASE.expo }}
            />
          ))}
          {/* the route public traffic actually takes today */}
          <motion.polyline
            points="2,58 22,30 50,52 82,40"
            fill="none" stroke="var(--color-signal)" strokeWidth="0.7"
            strokeDasharray="2 2"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ delay: 0.6, duration: 1.1, ease: EASE.glide }}
          />
          {pts.map(([x, y], i) => (
            <motion.circle
              key={i} cx={x} cy={y} r={i === 3 ? 2.4 : 1.7}
              fill={i === 3 ? 'var(--color-signal)' : '#8d99a6'}
              initial={{ scale: 0 }} animate={{ scale: 1 }}
              transition={{ delay: 0.2 + i * 0.07, duration: 0.4, ease: EASE.snap }}
              style={{ transformOrigin: `${x}px ${y}px` }}
            />
          ))}
          <text x="1" y="64" fill="#5d6672" fontSize="3.4" fontFamily="JetBrains Mono, monospace">ingress</text>
          <text x="76" y="46.5" fill="#939ba7" fontSize="3.4" fontFamily="JetBrains Mono, monospace">api</text>
        </svg>
        <div className="absolute bottom-0 left-0 font-mono text-[10.5px] text-[var(--color-fg-dim)]">
          api.yourdomain.dev → tunnel → mesh → node-04
        </div>
      </div>
    </Frame>
  )
}

/* 05 — fail over */
function Failing() {
  const beats = [1, 1, 1, 1, 1, 0, 0, 0]
  return (
    <Frame title="heartbeat · node-03" right="interval 5s">
      <div className="min-w-0 font-mono text-[11px] sm:text-[11.5px]">
        <div className="flex h-16 items-end gap-1.5">
          {beats.map((b, i) => (
            <motion.span
              key={i}
              initial={{ height: 4, opacity: 0 }}
              animate={{ height: b ? 44 : 4, opacity: 1 }}
              transition={{ delay: i * 0.12, duration: 0.35, ease: EASE.snap }}
              className="w-full"
              style={{ background: b ? 'var(--color-signal)' : 'var(--color-down)' }}
            />
          ))}
        </div>
        <motion.div {...row(9)} className="mt-4 text-[var(--color-down)]">
          missed 3/3 → node-03 marked down
        </motion.div>
        <div className="mt-3 min-w-0 space-y-2">
          <motion.div {...row(10)} className="flex items-center justify-between border border-[var(--color-line)] bg-[var(--color-ink-850)] px-3 py-2">
            <span className="text-[var(--color-fg)]">img-proxy</span>
            <span className="truncate pl-3 text-right text-[var(--color-signal)]">flexible → node-01</span>
          </motion.div>
          <motion.div {...row(11)} className="flex items-center justify-between border border-[color-mix(in_oklab,var(--color-warn)_35%,var(--color-line))] bg-[color-mix(in_oklab,var(--color-warn)_6%,transparent)] px-3 py-2">
            <span className="text-[var(--color-fg)]">postgres</span>
            <span className="truncate pl-3 text-right text-[var(--color-warn)]">pinned → alert only</span>
          </motion.div>
        </div>
      </div>
    </Frame>
  )
}

/* 06 — observe */
function Observe() {
  const events = [
    ['14:02:21', 'node-03 offline', 'down'],
    ['14:02:25', 'img-proxy rescheduled → node-01', 'ok'],
    ['14:02:25', 'postgres pinned-alert · discord', 'warn'],
    ['14:11:04', 'node-03 online · reclaim=idle', 'ok'],
    ['14:11:06', 'postgres resumed on node-03', 'ok'],
    ['14:18:40', 'deploy web 4f1c9ae → node-02', 'ok'],
  ]
  const tone = { ok: 'var(--color-signal)', warn: 'var(--color-warn)', down: 'var(--color-down)' }
  return (
    <Frame title="event timeline" right="fleet: homelab">
      <div className="min-w-0 space-y-0 font-mono text-[10.5px] sm:text-[11px]">
        {events.map(([t, e, k], i) => (
          <motion.div key={t + e} {...row(i)} className="flex items-center gap-3 border-b border-[var(--color-line)] py-2 last:border-0">
            <span className="text-[var(--color-fg-dim)]">{t}</span>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tone[k] }} />
            <span className="min-w-0 truncate text-[var(--color-fg-muted)]">{e}</span>
          </motion.div>
        ))}
      </div>
    </Frame>
  )
}

const VISUALS = [Register, Build, Place, Mesh, Failing, Observe]

export default function StepVisual({ index }) {
  const C = VISUALS[index] ?? Register
  return <C />
}
