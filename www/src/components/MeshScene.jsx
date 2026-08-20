import { useRef, useMemo, Suspense } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { NODES, EDGES, LABELLED } from '../lib/graph'

const SIGNAL = new THREE.Color('#3fe08b')
const DIM = new THREE.Color('#4a5763')

/* Live positions are recomputed every frame from a base position plus a very
   small drift, then reused by the edges, the pulses and the DOM labels. */
function useLivePositions() {
  return useMemo(
    () =>
      NODES.map((n, i) => ({
        base: new THREE.Vector3(...n.p),
        cur: new THREE.Vector3(...n.p),
        phase: i * 1.37,
        amp: 0.055 + (i % 3) * 0.018,
      })),
    []
  )
}

function Graph({ interactive, labelRefs }) {
  const group = useRef()
  const pts = useLivePositions()
  const nodeRefs = useRef([])
  const pingRefs = useRef([])
  const lineRef = useRef()
  const { size, camera } = useThree()

  const linePositions = useMemo(() => new Float32Array(EDGES.length * 6), [])
  const projected = useMemo(() => new THREE.Vector3(), [])

  // Travelling pulses: each rides one edge at its own speed and offset.
  const pulses = useMemo(
    () =>
      EDGES.map((e, i) => ({
        edge: e,
        t: (i * 0.31) % 1,
        speed: 0.085 + (i % 4) * 0.028,
      })),
    []
  )
  const pulseRefs = useRef([])

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime

    // idle drift — barely perceptible, this is not a demo scene
    pts.forEach((p, i) => {
      p.cur.set(
        p.base.x + Math.sin(t * 0.24 + p.phase) * p.amp,
        p.base.y + Math.cos(t * 0.19 + p.phase * 1.3) * p.amp,
        p.base.z + Math.sin(t * 0.16 + p.phase * 0.7) * p.amp * 0.8
      )
      const m = nodeRefs.current[i]
      if (m) m.position.copy(p.cur)
    })

    // edges follow the nodes
    const arr = linePositions
    EDGES.forEach(([a, b], i) => {
      const pa = pts[a].cur
      const pb = pts[b].cur
      arr.set([pa.x, pa.y, pa.z, pb.x, pb.y, pb.z], i * 6)
    })
    if (lineRef.current) lineRef.current.attributes.position.needsUpdate = true

    // heartbeat on the live node: two offset radar pings, not a glow blob
    pingRefs.current.forEach((m, i) => {
      if (!m) return
      const beat = ((t + i * 1.2) % 2.4) / 2.4
      const e = 1 - Math.pow(1 - beat, 2.2)
      m.position.copy(pts[0].cur)
      m.scale.setScalar(0.16 + e * 0.34)
      m.material.opacity = 0.5 * (1 - e)
    })

    // traffic pulses ride the edges
    pulses.forEach((pl, i) => {
      pl.t += delta * pl.speed
      if (pl.t > 1) pl.t -= 1
      const m = pulseRefs.current[i]
      if (!m) return
      m.position.lerpVectors(pts[pl.edge[0]].cur, pts[pl.edge[1]].cur, pl.t)
      const edgeFade = Math.sin(pl.t * Math.PI)
      m.material.opacity = 0.15 + edgeFade * 0.8
      m.scale.setScalar(0.5 + edgeFade * 0.7)
    })

    // cursor parallax — a tilt, not a rotation
    if (group.current && interactive) {
      const tx = state.pointer.y * 0.11
      const ty = state.pointer.x * 0.19
      group.current.rotation.x += (tx - group.current.rotation.x) * 0.045
      group.current.rotation.y += (ty - group.current.rotation.y) * 0.045
    }

    // Labels are plain DOM, positioned by projecting the node into screen
    // space. Cheaper than a 3D-transformed wrapper per label, and the type
    // stays pixel-crisp because nothing scales it.
    if (group.current) {
      group.current.updateMatrixWorld()
      LABELLED.forEach((nodeIdx, i) => {
        const el = labelRefs.current[i]
        if (!el) return
        projected.copy(pts[nodeIdx].cur).applyMatrix4(group.current.matrixWorld).project(camera)
        if (projected.z > 1) {
          el.style.opacity = '0'
          return
        }
        const x = (projected.x * 0.5 + 0.5) * size.width
        const y = (-projected.y * 0.5 + 0.5) * size.height
        el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`
        el.style.opacity = '1'
      })
    }
  })

  const scale = size.width < 640 ? 0.74 : size.width < 1280 ? 0.88 : 0.95

  return (
    <group ref={group} scale={scale} position={[-0.28, 0, 0]}>
      <lineSegments>
        <bufferGeometry ref={lineRef}>
          <bufferAttribute attach="attributes-position" args={[linePositions, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={DIM} transparent opacity={0.34} />
      </lineSegments>

      {pulses.map((_, i) => (
        <mesh key={`p${i}`} ref={(el) => (pulseRefs.current[i] = el)}>
          <sphereGeometry args={[0.035, 8, 8]} />
          <meshBasicMaterial color={SIGNAL} transparent opacity={0.8} />
        </mesh>
      ))}

      {[0, 1].map((i) => (
        <mesh key={`ping${i}`} ref={(el) => (pingRefs.current[i] = el)}>
          <ringGeometry args={[0.86, 1, 40]} />
          <meshBasicMaterial color={SIGNAL} transparent opacity={0.4} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      ))}

      {NODES.map((n, i) => (
        <mesh key={n.id} ref={(el) => (nodeRefs.current[i] = el)}>
          <icosahedronGeometry args={[n.r, 1]} />
          <meshBasicMaterial
            color={n.live ? SIGNAL : '#8d99a6'}
            transparent
            opacity={n.live ? 1 : 0.72}
          />
        </mesh>
      ))}
    </group>
  )
}

export default function MeshScene({ interactive = true, active = true }) {
  const labelRefs = useRef([])

  return (
    <div className="relative h-full w-full">
      <Canvas
        dpr={[1, 1.5]}
        // Nothing renders while the hero is off screen — no GPU burn on a page
        // the reader has already scrolled past.
        frameloop={active ? 'always' : 'never'}
        camera={{ position: [0, 0, 6.1], fov: 42 }}
        gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }}
        style={{ pointerEvents: 'none' }}
      >
        <Suspense fallback={null}>
          <Graph interactive={interactive} labelRefs={labelRefs} />
        </Suspense>
      </Canvas>

      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {LABELLED.map((idx, i) => {
          const n = NODES[idx]
          return (
            <div
              key={n.id}
              ref={(el) => (labelRefs.current[i] = el)}
              style={{ opacity: 0, willChange: 'transform' }}
              className="absolute left-0 top-0 transition-opacity duration-500"
            >
              <div
                className={`-translate-y-1/2 whitespace-nowrap ${
                  n.side === 'left'
                    ? '-translate-x-[calc(100%+14px)] text-right'
                    : n.live
                      ? 'translate-x-9'
                      : 'translate-x-4'
                }`}
              >
                <div
                  className={`flex items-center gap-1.5 font-mono text-[10px] leading-none tracking-[0.06em] text-[var(--color-fg-muted)] ${
                    n.side === 'left' ? 'flex-row-reverse' : ''
                  }`}
                >
                  <span
                    className="inline-block h-[5px] w-[5px] rounded-full"
                    style={{
                      background: n.live ? 'var(--color-signal)' : 'var(--color-fg-dim)',
                      animation: n.live ? 'signal-pulse 2.4s ease-out infinite' : 'none',
                    }}
                  />
                  {n.label}
                </div>
                <div
                  className={`mt-1 font-mono text-[9px] leading-none tracking-[0.06em] text-[var(--color-fg-dim)] ${
                    n.side === 'left' ? 'pr-[11px]' : 'pl-[11px]'
                  }`}
                >
                  {n.arch} · {n.tier}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
