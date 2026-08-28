import { useState, useMemo, useRef, useEffect, useCallback, type ReactNode } from 'react'
import { type Node, type PlacementMapNode } from '../lib/api'
import { mb, pct, toneOf } from '../lib/format'
import { Dot, Meter } from './ui'

export interface ClusterMeshVisualizerProps {
  mapNodes: PlacementMapNode[]
  nodes: Node[]
  fleetName?: string
  className?: string
}

/* ── Geometry helpers ────────────────────────────────────────── */

/** Places worker nodes in a circle around a centre control-plane node. */
function layoutNodes(count: number, cx: number, cy: number, rx: number, ry: number) {
  return Array.from({ length: count }, (_, i) => {
    const angle = (2 * Math.PI * i) / count - Math.PI / 2
    return {
      x: cx + rx * Math.cos(angle),
      y: cy + ry * Math.sin(angle),
    }
  })
}

/** SVG bezier curve between two points, bowed outward slightly. */
function curvedPath(x1: number, y1: number, x2: number, y2: number): string {
  const mx = (x1 + x2) / 2
  const my = (y1 + y2) / 2
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.sqrt(dx * dx + dy * dy)
  const bow = Math.min(len * 0.12, 28)
  const nx = -dy / len
  const ny = dx / len
  return `M ${x1} ${y1} Q ${mx + nx * bow} ${my + ny * bow} ${x2} ${y2}`
}

/* ── Tooltip ─────────────────────────────────────────────────── */

function Tooltip({ children, x, y, visible }: { children: ReactNode; x: number; y: number; visible: boolean }) {
  if (!visible) return null
  return (
    <div
      className="pointer-events-none absolute z-50 max-w-[260px] rounded-[4px] border border-[var(--color-line-2)] bg-[var(--color-ink-900)] px-4 py-3 font-mono text-[11px] shadow-2xl transition-opacity duration-150"
      style={{
        left: x,
        top: y,
        transform: 'translate(-50%, calc(-100% - 12px))',
        opacity: visible ? 1 : 0,
      }}
    >
      {children}
    </div>
  )
}

/* ── Main Component ──────────────────────────────────────────── */

export default function ClusterMeshVisualizer({
  mapNodes,
  nodes,
  fleetName = 'Fleet',
  className = '',
}: ClusterMeshVisualizerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 })
  const [dims, setDims] = useState({ w: 800, h: 480 })

  // Resize observer to keep the SVG responsive
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return
      const { width } = entry.contentRect
      setDims({ w: width, h: Math.max(400, Math.min(560, width * 0.56)) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Merge placement map info with live telemetry from the full Node list
  const enriched = useMemo(() => {
    return mapNodes.map((mn) => {
      const liveNode = nodes.find((n) => n.id === mn.id)
      return {
        ...mn,
        telemetry: liveNode?.telemetry ?? null,
        os: liveNode?.os ?? '?',
        arch: mn.arch,
        agentVersion: liveNode?.agentVersion ?? null,
        live: liveNode?.live ?? false,
        meshConnected: liveNode?.telemetry?.meshConnected ?? false,
      }
    })
  }, [mapNodes, nodes])

  // Layout geometry
  const cx = dims.w / 2
  const cy = dims.h / 2
  const rx = Math.min(dims.w * 0.36, 300)
  const ry = Math.min(dims.h * 0.36, 200)
  const positions = layoutNodes(enriched.length, cx, cy, rx, ry)

  // Handle hover on a node
  const handleNodeHover = useCallback(
    (nodeId: string | null, e?: React.MouseEvent) => {
      setHovered(nodeId)
      if (e && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect()
        setTooltipPos({ x: e.clientX - rect.left, y: e.clientY - rect.top })
      }
    },
    []
  )

  const hoveredNode = enriched.find((n) => n.id === hovered)

  // Count totals for the control-plane badge
  const onlineCount = enriched.filter((n) => n.status === 'online').length
  const totalContainers = enriched.reduce(
    (sum, n) => sum + (n.telemetry?.containers?.length ?? n.services.length),
    0
  )

  return (
    <div ref={containerRef} className={`relative overflow-hidden ${className}`}>
      {/* ── Header ──────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--color-line)]">
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-dim)]">
            Cluster Topology
          </span>
          <span className="font-mono text-[10px] text-[var(--color-fg-dim)]">·</span>
          <span className="font-mono text-[10.5px] text-[var(--color-fg-muted)]">{fleetName}</span>
        </div>
        <div className="flex items-center gap-4 font-mono text-[10px] text-[var(--color-fg-dim)]">
          <span className="flex items-center gap-1.5">
            <Dot tone="ok" size={5} />
            {onlineCount} online
          </span>
          <span>{totalContainers} containers</span>
        </div>
      </div>

      {/* ── SVG Canvas ──────────────────────────────────────── */}
      <div className="relative grid-bg" style={{ height: dims.h }}>
        <svg
          width={dims.w}
          height={dims.h}
          viewBox={`0 0 ${dims.w} ${dims.h}`}
          className="absolute inset-0"
          style={{ overflow: 'visible' }}
        >
          <defs>
            {/* Gradient for active tunnel lines */}
            <linearGradient id="tunnel-grad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="var(--color-signal)" stopOpacity="0.6" />
              <stop offset="50%" stopColor="var(--color-signal)" stopOpacity="0.25" />
              <stop offset="100%" stopColor="var(--color-signal)" stopOpacity="0.6" />
            </linearGradient>
            <linearGradient id="tunnel-offline" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="var(--color-down)" stopOpacity="0.3" />
              <stop offset="100%" stopColor="var(--color-down)" stopOpacity="0.1" />
            </linearGradient>

            {/* Glow filter for control plane */}
            <filter id="cp-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
          </defs>

          {/* ── Connection lines (Node → Control Plane) ────── */}
          {positions.map((pos, i) => {
            const node = enriched[i]!
            const isOnline = node.status === 'online'
            const hasTunnel = node.meshConnected
            const pathD = curvedPath(cx, cy, pos.x, pos.y)

            return (
              <g key={`edge-${node.id}`}>
                {/* Base line (always drawn, subtle) */}
                <path
                  d={pathD}
                  fill="none"
                  stroke={isOnline ? 'var(--color-line-2)' : 'var(--color-line)'}
                  strokeWidth={1.2}
                  strokeDasharray={isOnline ? 'none' : '4 4'}
                  opacity={isOnline ? 0.6 : 0.3}
                />

                {/* Animated tunnel overlay when mesh is connected */}
                {isOnline && hasTunnel && (
                  <path
                    d={pathD}
                    fill="none"
                    stroke="url(#tunnel-grad)"
                    strokeWidth={2}
                    strokeDasharray="8 12"
                    className="animate-dash-flow"
                  />
                )}

                {/* Offline dashed overlay */}
                {!isOnline && (
                  <path
                    d={pathD}
                    fill="none"
                    stroke="url(#tunnel-offline)"
                    strokeWidth={1.5}
                    strokeDasharray="3 6"
                  />
                )}
              </g>
            )
          })}

          {/* ── Control Plane Centre ─────────────────────────── */}
          <g>
            {/* Outer pulse ring */}
            <circle cx={cx} cy={cy} r={32} fill="none" stroke="var(--color-signal)" strokeWidth={1} opacity={0.2}>
              <animate attributeName="r" from="28" to="42" dur="2.5s" repeatCount="indefinite" />
              <animate attributeName="opacity" from="0.25" to="0" dur="2.5s" repeatCount="indefinite" />
            </circle>

            {/* Core circle */}
            <circle cx={cx} cy={cy} r={26} fill="var(--color-ink-800)" stroke="var(--color-signal)" strokeWidth={1.5} filter="url(#cp-glow)" />
            <circle cx={cx} cy={cy} r={4} fill="var(--color-signal)" />

            {/* Label */}
            <text x={cx} y={cy - 36} textAnchor="middle" fill="var(--color-fg)" fontSize="10" fontFamily="var(--font-mono)" fontWeight="600" letterSpacing="0.08em">
              CONTROL PLANE
            </text>
            <text x={cx} y={cy + 45} textAnchor="middle" fill="var(--color-fg-dim)" fontSize="9" fontFamily="var(--font-mono)">
              INGRESS EDGE
            </text>
          </g>

          {/* ── Worker Nodes ─────────────────────────────────── */}
          {positions.map((pos, i) => {
            const node = enriched[i]!
            const isOnline = node.status === 'online'
            const tone = toneOf(node.status)
            const isHovered = hovered === node.id
            const nodeRadius = isHovered ? 22 : 18

            const fillColor =
              tone === 'ok'
                ? 'var(--color-ink-800)'
                : tone === 'warn'
                ? 'color-mix(in oklab, var(--color-warn) 10%, var(--color-ink-800))'
                : tone === 'down'
                ? 'color-mix(in oklab, var(--color-down) 10%, var(--color-ink-800))'
                : 'var(--color-ink-850)'

            const strokeColor =
              tone === 'ok'
                ? 'var(--color-signal-dim)'
                : tone === 'warn'
                ? 'var(--color-warn)'
                : tone === 'down'
                ? 'var(--color-down)'
                : 'var(--color-line-2)'

            return (
              <g
                key={`node-${node.id}`}
                onMouseEnter={(e) => handleNodeHover(node.id, e)}
                onMouseMove={(e) => handleNodeHover(node.id, e)}
                onMouseLeave={() => handleNodeHover(null)}
                className="cursor-pointer"
                style={{ transition: 'transform 0.2s ease' }}
              >
                {/* Hover ring */}
                {isHovered && (
                  <circle cx={pos.x} cy={pos.y} r={nodeRadius + 5} fill="none" stroke={strokeColor} strokeWidth={0.8} opacity={0.4}>
                    <animate attributeName="r" from={nodeRadius + 2} to={nodeRadius + 8} dur="1.5s" repeatCount="indefinite" />
                    <animate attributeName="opacity" from="0.4" to="0" dur="1.5s" repeatCount="indefinite" />
                  </circle>
                )}

                {/* Node circle */}
                <circle
                  cx={pos.x}
                  cy={pos.y}
                  r={nodeRadius}
                  fill={fillColor}
                  stroke={strokeColor}
                  strokeWidth={isHovered ? 2 : 1.2}
                  style={{ transition: 'r 0.2s ease, stroke-width 0.2s ease' }}
                />

                {/* Inner status dot */}
                <circle cx={pos.x} cy={pos.y} r={3} fill={
                  tone === 'ok' ? 'var(--color-signal)' :
                  tone === 'warn' ? 'var(--color-warn)' :
                  tone === 'down' ? 'var(--color-down)' :
                  'var(--color-fg-dim)'
                } />

                {/* Hostname label */}
                <text
                  x={pos.x}
                  y={pos.y + nodeRadius + 14}
                  textAnchor="middle"
                  fill={isHovered ? 'var(--color-fg)' : 'var(--color-fg-muted)'}
                  fontSize="10"
                  fontFamily="var(--font-mono)"
                  fontWeight={isHovered ? '600' : '400'}
                  style={{ transition: 'fill 0.15s ease' }}
                >
                  {node.name}
                </text>

                {/* Architecture badge */}
                <text
                  x={pos.x}
                  y={pos.y + nodeRadius + 25}
                  textAnchor="middle"
                  fill="var(--color-fg-dim)"
                  fontSize="8"
                  fontFamily="var(--font-mono)"
                >
                  {node.arch}{node.reliabilityTier !== 'standard' ? ` · ${node.reliabilityTier}` : ''}
                </text>

                {/* Tunnel badge */}
                {isOnline && (
                  <g>
                    <rect
                      x={pos.x - 36}
                      y={pos.y - nodeRadius - 18}
                      width={72}
                      height={14}
                      rx={3}
                      fill={node.meshConnected ? 'color-mix(in oklab, var(--color-signal) 12%, var(--color-ink-900))' : 'var(--color-ink-900)'}
                      stroke={node.meshConnected ? 'var(--color-signal-dim)' : 'var(--color-line)'}
                      strokeWidth={0.8}
                    />
                    <text
                      x={pos.x}
                      y={pos.y - nodeRadius - 9}
                      textAnchor="middle"
                      fill={node.meshConnected ? 'var(--color-signal)' : 'var(--color-fg-dim)'}
                      fontSize="7.5"
                      fontFamily="var(--font-mono)"
                      letterSpacing="0.04em"
                    >
                      {node.meshConnected ? '🟢 Tunnel Active' : '○ No Tunnel'}
                    </text>
                  </g>
                )}

                {/* Container workload count pill */}
                {node.services.length > 0 && (
                  <g>
                    <rect
                      x={pos.x + nodeRadius - 2}
                      y={pos.y - nodeRadius + 2}
                      width={16}
                      height={14}
                      rx={7}
                      fill="var(--color-signal-dim)"
                    />
                    <text
                      x={pos.x + nodeRadius + 6}
                      y={pos.y - nodeRadius + 12}
                      textAnchor="middle"
                      fill="var(--color-fg)"
                      fontSize="8"
                      fontFamily="var(--font-mono)"
                      fontWeight="600"
                    >
                      {node.services.length}
                    </text>
                  </g>
                )}
              </g>
            )
          })}
        </svg>

        {/* ── Tooltip overlay (HTML positioned over SVG) ────── */}
        <Tooltip x={tooltipPos.x} y={tooltipPos.y} visible={!!hoveredNode}>
          {hoveredNode && (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-4">
                <span className="font-semibold text-[12px] text-[var(--color-fg)]">{hoveredNode.name}</span>
                <span className={`text-[9px] uppercase tracking-[0.1em] ${
                  hoveredNode.status === 'online' ? 'text-[var(--color-signal)]' :
                  hoveredNode.status === 'offline' ? 'text-[var(--color-down)]' :
                  'text-[var(--color-warn)]'
                }`}>
                  {hoveredNode.status}
                </span>
              </div>

              <div className="flex flex-wrap gap-1.5 text-[9px] text-[var(--color-fg-dim)]">
                <span className="rounded-[2px] border border-[var(--color-line)] bg-[var(--color-ink-950)] px-1.5 py-0.5">{hoveredNode.os}</span>
                <span className="rounded-[2px] border border-[var(--color-line)] bg-[var(--color-ink-950)] px-1.5 py-0.5">{hoveredNode.arch}</span>
                {hoveredNode.agentVersion && (
                  <span className="rounded-[2px] border border-[var(--color-line)] bg-[var(--color-ink-950)] px-1.5 py-0.5">v{hoveredNode.agentVersion}</span>
                )}
              </div>

              {/* Telemetry Meters */}
              {hoveredNode.telemetry && (
                <div className="space-y-1.5 pt-1">
                  <Meter
                    value={hoveredNode.telemetry.cpuPct}
                    max={1}
                    label={`CPU ${pct(hoveredNode.telemetry.cpuPct)}`}
                    warnAt={0.8}
                  />
                  <Meter
                    value={hoveredNode.telemetry.ramUsedMb}
                    max={hoveredNode.ramMb}
                    label={`RAM ${mb(hoveredNode.telemetry.ramUsedMb)} / ${mb(hoveredNode.ramMb)}`}
                    warnAt={0.85}
                  />
                </div>
              )}

              {/* Services on this node */}
              {hoveredNode.services.length > 0 && (
                <div className="pt-1 border-t border-[var(--color-line)]">
                  <div className="text-[8.5px] uppercase tracking-[0.12em] text-[var(--color-fg-dim)] mb-1.5">
                    Workloads
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {hoveredNode.services.map((s) => (
                      <span
                        key={s.name}
                        className={`inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-0.5 text-[9px] ${
                          s.status === 'pinned_unavailable'
                            ? 'border-[var(--color-warn)] bg-[color-mix(in_oklab,var(--color-warn)_8%,transparent)] text-[var(--color-warn)]'
                            : 'border-[var(--color-line)] bg-[var(--color-ink-950)] text-[var(--color-fg-muted)]'
                        }`}
                      >
                        <Dot tone={toneOf(s.status)} size={4} />
                        {s.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Mesh status */}
              <div className="pt-1 border-t border-[var(--color-line)] flex items-center gap-2">
                <span className={`h-1.5 w-1.5 rounded-full ${hoveredNode.meshConnected ? 'bg-[var(--color-signal)]' : 'bg-[var(--color-fg-dim)]'}`} />
                <span className="text-[9px] text-[var(--color-fg-muted)]">
                  Reverse Tunnel: {hoveredNode.meshConnected ? 'Active' : 'Inactive'}
                </span>
              </div>
            </div>
          )}
        </Tooltip>
      </div>

      {/* ── Legend ───────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-5 border-t border-[var(--color-line)] px-5 py-2.5 font-mono text-[9.5px] text-[var(--color-fg-dim)]">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-[2px] w-4 bg-[var(--color-signal)]" style={{ strokeDasharray: '8 12' }} />
          Tunnel Active
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-[2px] w-4 bg-[var(--color-line-2)]" />
          Connected
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-[2px] w-4 bg-[var(--color-down)] opacity-30" style={{ borderTop: '2px dashed' }} />
          Offline
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-[var(--color-signal)]" />
          Online
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-[var(--color-down)]" />
          Offline
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-[var(--color-warn)]" />
          Draining / Cordoned
        </span>
      </div>
    </div>
  )
}
