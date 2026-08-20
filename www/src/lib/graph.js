// One graph definition, shared by the WebGL hero scene, the static fallback
// and the ambient footer canvas — so all three show the same fleet.
//
// The layout is deliberately weighted to the right: the hero copy occupies the
// left of the viewport, and no node should ever land on the headline.
export const NODES = [
  { id: 'node-01', label: 'home-server', arch: 'amd64', tier: 'always-on', p: [-0.20, 0.58, 0.20], live: true, r: 0.115 },
  { id: 'node-02', label: 'raspberry pi 5', arch: 'arm64', tier: 'always-on', p: [1.62, 1.02, -0.50], r: 0.085 },
  { id: 'node-03', label: 'thinkpad', arch: 'amd64', tier: 'intermittent', p: [0.42, -1.18, 0.55], r: 0.075 },
  { id: 'node-04', label: 'vps · burst', arch: 'amd64', tier: 'burst', p: [2.08, -0.40, 0.12], r: 0.09, side: 'left' },
  { id: 'node-05', label: 'pi zero 2 w', arch: 'armv7', tier: 'intermittent', p: [1.02, 0.14, -0.15], r: 0.062 },
  { id: 'node-06', label: 'mini pc', arch: 'amd64', tier: 'always-on', p: [-1.02, -0.62, -0.42], r: 0.078 },
]

export const EDGES = [
  [0, 4], [0, 2], [0, 5], [4, 1], [4, 3], [4, 2],
  [1, 3], [2, 5], [0, 1],
]

// Which nodes carry a visible label in the hero.
export const LABELLED = [0, 1, 3]
