import { NODES, EDGES, LABELLED } from '../lib/graph'

// Static, no-motion twin of the hero scene. Same graph, same labels,
// drawn once in SVG. Shown when WebGL or motion is off the table.
export default function MeshStatic() {
  const toX = (x) => 50 + x * 17
  const toY = (y) => 50 - y * 17

  return (
    <svg viewBox="0 0 100 100" className="h-full w-full" role="img" aria-label="Fleet mesh graph: six nodes connected by encrypted links">
      {EDGES.map(([a, b], i) => (
        <line
          key={i}
          x1={toX(NODES[a].p[0])}
          y1={toY(NODES[a].p[1])}
          x2={toX(NODES[b].p[0])}
          y2={toY(NODES[b].p[1])}
          stroke="#4a5763"
          strokeOpacity="0.4"
          strokeWidth="0.25"
        />
      ))}
      {NODES.map((n, i) => (
        <g key={n.id}>
          {n.live && (
            <circle cx={toX(n.p[0])} cy={toY(n.p[1])} r={n.r * 34} fill="#3fe08b" fillOpacity="0.13" />
          )}
          <circle
            cx={toX(n.p[0])}
            cy={toY(n.p[1])}
            r={n.r * 11}
            fill={n.live ? '#3fe08b' : '#8d99a6'}
            fillOpacity={n.live ? 1 : 0.72}
          />
        </g>
      ))}
      {LABELLED.map((idx) => {
        const n = NODES[idx]
        return (
          <text
            key={idx}
            x={toX(n.p[0]) + 3}
            y={toY(n.p[1]) + 0.9}
            fill="#939ba7"
            fontSize="2.2"
            fontFamily="JetBrains Mono, monospace"
            letterSpacing="0.1"
          >
            {n.label}
          </text>
        )
      })}
    </svg>
  )
}
