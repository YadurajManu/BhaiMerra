import { useState, useMemo, useRef, useEffect, useCallback, type ReactNode } from 'react'
import { type Node, type PlacementMapNode } from '../lib/api'
import { mb, pct, toneOf } from '../lib/format'
import { Dot, Meter } from './ui'

export interface ClusterMeshVisualizerProps {
  mapNodes: PlacementMapNode[]
  nodes: Node[]
  fleetName?: string
  className?: string
  /** Clicking a node. Without these the graph is a picture, not a control. */
  onSelectNode?: (nodeId: string) => void
  /** Clicking one of a node's services. */
  onSelectService?: (serviceName: string) => void
}

/* ── Geometry helpers ────────────────────────────────────────── */

/**
 * Places worker nodes around the control plane.
 *
 * One ellipse for every fleet size put two nodes directly above and below the
 * centre — the tallest arrangement possible on a canvas that is wider than it
 * is tall, leaving two thirds of it empty and pushing the top node's labels
 * into the header. Small fleets are the common case and deserve a layout that
 * fits them; the ellipse only earns its keep once there are enough nodes to
 * need a full circle.
 */
function layoutNodes(count: number, cx: number, cy: number, rx: number, ry: number) {
  if (count === 0) return []
  // A single node sits beside the control plane, not orbiting it.
  if (count === 1) return [{ x: cx + rx * 0.85, y: cy }]
  // Two go left and right, along the axis there is actually room on.
  if (count === 2) {
    return [
      { x: cx - rx, y: cy },
      { x: cx + rx, y: cy },
    ]
  }
  // Three or four fan across the horizontal, still avoiding dead centre-top.
  if (count <= 4) {
    return Array.from({ length: count }, (_, i) => {
      const spread = Math.PI * 0.82
      const angle = Math.PI / 2 + spread / 2 - (spread * i) / (count - 1)
      return { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) * 0.75 }
    })
  }
  // Enough nodes for the circle to read as a circle. Start at the left so the
  // first node never lands under the panel header.
  return Array.from({ length: count }, (_, i) => {
    const angle = Math.PI + (2 * Math.PI * i) / count
    return { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) }
  })
}

/**
 * Where a node's services sit relative to it.
 *
 * Fanned on the side facing away from the control plane, so a service never
 * lands on top of the edge connecting its node to the centre.
 */
function layoutServices(count: number, nx: number, ny: number, cx: number, cy: number) {
  if (count === 0) return []
  const away = Math.atan2(ny - cy, nx - cx)
  const ring = 40
  // A single service sits straight out; several fan across a quarter turn.
  const spread = Math.min(Math.PI * 0.62, 0.34 * count)
  return Array.from({ length: count }, (_, i) => {
    const angle = count === 1 ? away : away - spread / 2 + (spread * i) / (count - 1)
    return { x: nx + ring * Math.cos(angle), y: ny + ring * Math.sin(angle) }
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

/**
 * A key to what is on screen, and nothing else.
 *
 * The legend was a fixed list of six states. A fleet showing one of them got
 * five lines describing colours that were not there, which is how a reader
 * learns to stop looking at the legend at all.
 */
function Legend({ enriched }: { enriched: Array<{ status: string; tunnelConnected: boolean; services: Array<{ status: string }> }> }) {
  const items: Array<{ swatch: string; label: string }> = []
  const add = (swatch: string, label: string) => {
    if (!items.some((i) => i.label === label)) items.push({ swatch, label })
  }

  for (const node of enriched) {
    const tone = toneOf(node.status)
    if (tone === 'ok') add('var(--color-signal)', 'node online')
    else if (tone === 'down') add('var(--color-down)', 'node offline')
    else if (tone === 'warn') add('var(--color-warn)', 'draining / cordoned')
    if (node.tunnelConnected) add('var(--color-signal-dim)', 'tunnel connected')

    for (const svc of node.services) {
      const st = toneOf(svc.status)
      if (st === 'ok') add('var(--color-signal)', 'service running')
      else if (st === 'down') add('var(--color-down)', 'service down')
      else if (st === 'warn') add('var(--color-warn)', 'service deploying')
    }
  }

  if (!items.length) return null
  return (
    <div className="flex flex-wrap items-center gap-5 border-t border-[var(--color-line)] px-5 py-2.5 font-mono text-[9.5px] text-[var(--color-fg-dim)]">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: i.swatch }} />
          {i.label}
        </span>
      ))}
    </div>
  )
}

/* ── Main Component ──────────────────────────────────────────── */

export default function ClusterMeshVisualizer({
  mapNodes,
  nodes,
  fleetName = 'Fleet',
  className = '',
  onSelectNode,
  onSelectService,
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
        // The tunnel the control plane is actually holding, not the WireGuard
        // mesh flag the agent never sets — which is why every node used to
        // read "No Tunnel" while its tunnel was up and serving ingress.
        tunnelConnected: liveNode?.tunnelConnected ?? false,
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

  /** Keyboard focus, which is separate from the mouse's idea of "hovered". */
  const [focused, setFocused] = useState<string | null>(null)
  const active = hovered ?? focused

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
            const isHovered = active === node.id
            const nodeRadius = isHovered ? 22 : 18
            const servicePos = layoutServices(node.services.length, pos.x, pos.y, cx, cy)

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
                // The richest view in the product used to be something you
                // could only look at. A node is a link to the node.
                role="link"
                tabIndex={0}
                aria-label={`${node.name}, ${node.status}, ${node.services.length} service${node.services.length === 1 ? '' : 's'}`}
                onFocus={() => setFocused(node.id)}
                onBlur={() => setFocused(null)}
                onClick={() => onSelectNode?.(node.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelectNode?.(node.id)
                  }
                }}
                className="cursor-pointer outline-none [&:focus-visible>circle:nth-of-type(1)]:stroke-[var(--color-signal)]"
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
                      fill={node.tunnelConnected ? 'color-mix(in oklab, var(--color-signal) 12%, var(--color-ink-900))' : 'var(--color-ink-900)'}
                      stroke={node.tunnelConnected ? 'var(--color-signal-dim)' : 'var(--color-line)'}
                      strokeWidth={0.8}
                    />
                    <text
                      x={pos.x}
                      y={pos.y - nodeRadius - 9}
                      textAnchor="middle"
                      fill={node.tunnelConnected ? 'var(--color-signal)' : 'var(--color-fg-dim)'}
                      fontSize="7.5"
                      fontFamily="var(--font-mono)"
                      letterSpacing="0.04em"
                    >
                      {node.tunnelConnected ? '🟢 Tunnel Active' : '○ No Tunnel'}
                    </text>
                  </g>
                )}

                {/* ── Services, as satellites of the node they run on ──
                    A topology view that draws only the boxes is a list with
                    extra steps. What runs where is the question the picture
                    exists to answer. */}
                {servicePos.map((sp, si) => {
                  const svc = node.services[si]!
                  const svcTone = toneOf(svc.status)
                  const svcColor =
                    svcTone === 'ok'
                      ? 'var(--color-signal)'
                      : svcTone === 'warn'
                        ? 'var(--color-warn)'
                        : svcTone === 'down'
                          ? 'var(--color-down)'
                          : 'var(--color-fg-dim)'
                  return (
                    <g
                      key={`svc-${node.id}-${svc.name}`}
                      role="link"
                      tabIndex={0}
                      aria-label={`service ${svc.name} on ${node.name}, ${svc.status}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        onSelectService?.(svc.name)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          e.stopPropagation()
                          onSelectService?.(svc.name)
                        }
                      }}
                      className="cursor-pointer outline-none"
                    >
                      {/* Tether, so it reads as belonging to this node. */}
                      <line
                        x1={pos.x}
                        y1={pos.y}
                        x2={sp.x}
                        y2={sp.y}
                        stroke="var(--color-line-2)"
                        strokeWidth={0.7}
                        opacity={isHovered ? 0.9 : 0.45}
                        style={{ transition: 'opacity 0.2s ease' }}
                      />
                      <circle
                        cx={sp.x}
                        cy={sp.y}
                        r={isHovered ? 6 : 5}
                        fill={`color-mix(in oklab, ${svcColor} 18%, var(--color-ink-900))`}
                        stroke={svcColor}
                        strokeWidth={1}
                        style={{ transition: 'r 0.2s ease' }}
                      >
                        {/* Only a service still coming up should move. */}
                        {svc.status === 'deploying' && (
                          <animate attributeName="opacity" values="1;0.35;1" dur="1.6s" repeatCount="indefinite" />
                        )}
                      </circle>
                      {/* Names only once the node is under attention, or a
                          busy fleet becomes unreadable. */}
                      {isHovered && (
                        <text
                          x={sp.x}
                          y={sp.y - 9}
                          textAnchor="middle"
                          fill="var(--color-fg-muted)"
                          fontSize="7.5"
                          fontFamily="var(--font-mono)"
                        >
                          {svc.name}
                        </text>
                      )}
                    </g>
                  )
                })}
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

              {/* Two different subsystems, and they were sharing one label:
                  the tunnel is the socket the control plane holds right now,
                  the mesh is WireGuard between nodes. Reporting the mesh flag
                  as "Reverse Tunnel" is how a working tunnel read as down. */}
              <div className="pt-1 border-t border-[var(--color-line)] flex items-center gap-2">
                <span className={`h-1.5 w-1.5 rounded-full ${hoveredNode.tunnelConnected ? 'bg-[var(--color-signal)]' : 'bg-[var(--color-fg-dim)]'}`} />
                <span className="text-[9px] text-[var(--color-fg-muted)]">
                  Reverse tunnel: {hoveredNode.tunnelConnected ? 'connected' : 'not connected'}
                </span>
              </div>
              <div className="text-[9px] text-[var(--color-fg-dim)]">
                Enter opens this node · click a satellite for its service
              </div>
            </div>
          )}
        </Tooltip>
      </div>

      {/* ── Legend ───────────────────────────────────────────────
          Only what is actually on screen. A fixed list of six states on a
          fleet showing one of them is a key to a map of somewhere else, and
          it teaches the reader to ignore the legend entirely. */}
      <Legend enriched={enriched} />

      <p className="border-t border-[var(--color-line)] px-5 py-2 font-mono text-[9.5px] text-[var(--color-fg-dim)]">
        Tab to move between nodes and services · Enter to open
      </p>
    </div>
  )
}
