# Fleet OS — marketing site

Single-page marketing site for Fleet OS: git-push deploys onto hardware you already own.

```bash
npm install
npm run dev
```

`npm run build` emits a static bundle to `dist/`.

## Stack

| Concern | Choice |
| --- | --- |
| App | React 19 + Vite |
| Styling | Tailwind v4 (CSS-first `@theme` in `src/index.css`) |
| Motion | Framer Motion — per-behaviour easing in `src/lib/motion.js` |
| Hero graph | React Three Fiber, lazy-loaded (`src/components/MeshScene.jsx`). Labels are DOM, positioned by projecting each node into screen space, so type stays crisp and follows the drift. |
| Footer graph | 2D canvas (`src/components/AmbientMesh.jsx`) — lighter than a second WebGL context |
| Scroll | Lenis, dynamically imported, skipped under `prefers-reduced-motion` |

## Routes

The landing page is `#` (with `#how`, `#failover`, `#compare`, `#cli`, `#pricing`
section anchors). Everything else is a hash route rendered by `PageShell`:

| Area | Routes |
| --- | --- |
| Docs | `#/docs`, `#/docs/fleet-yaml`, `#/docs/scheduler`, `#/docs/mesh`, `#/docs/failover`, `#/docs/cli`, `#/docs/api`, `#/docs/self-hosting` |
| Product | `#/changelog`, `#/roadmap`, `#/github` |
| Company | `#/about`, `#/blog`, `#/security`, `#/status`, `#/contact`, `#/community` |
| Legal | `#/legal/privacy`, `#/legal/terms`, `#/legal/licence` |

Page content lives in `src/lib/pages.js` as typed blocks (`h`, `p`, `list`,
`code`, `kv`, `table`, `note`, `links`, `status`); `PageShell` renders them,
builds the sticky table of contents from the `h` blocks, and derives prev/next
from `PAGE_ORDER`. Unknown routes render an in-theme 404.

To check nothing dangles after editing links or pages:

```bash
node --input-type=module -e "import{PAGES}from'./src/lib/pages.js';import{FOOTER_LINKS,LEGAL_LINKS}from'./src/lib/data.js';const k=new Set(Object.keys(PAGES));const b=[];[...FOOTER_LINKS.flatMap(c=>c.links),...LEGAL_LINKS].forEach(([l,h])=>{if(h.startsWith('#/')&&!k.has(h.slice(2)))b.push(l+' '+h)});console.log(b.length?b:'all links resolve')"
```

## Structure

- `src/lib/data.js` — every string on the page. Copy edits happen here, not in JSX.
- `src/lib/graph.js` — one node/edge topology shared by the WebGL hero, the SVG
  fallback and the footer canvas, so all three show the same fleet.
- `src/components/StepVisuals.jsx` — the six "how it works" dioramas.
- `src/components/Failover.jsx` — the failover simulator (driveable state machine,
  autoplays once on first view).
- `src/components/Terminal.jsx` — typed CLI session, starts on scroll-in.
- `src/lib/pages.js` — content for all 20 sub-pages.
- `src/components/PageShell.jsx` — sub-page renderer, TOC, prev/next, 404.
- `src/components/ui/Logo.jsx` — the mark: six peers, one live, edges that draw in.
- `src/lib/router.js` — hash router, so the site stays deployable as static files.
- `src/lib/nav.js` — the site map, shared by the mobile menu so it cannot drift.
- `src/components/MobileMenu.jsx` — full-screen menu covering every route.

## Share card

`public/og.png` is generated from `scripts/og-card.svg`, so the card and the
site stay in sync. Regenerate after changing the headline or the mark:

```bash
rsvg-convert -w 1200 -h 630 scripts/og-card.svg -o public/og.png
```

Open Graph and Twitter tags live in [index.html](index.html) and point at
`https://fleet-os.dev/og.png` — update the absolute URL if the domain changes,
since crawlers do not resolve relative image paths.

**Known limit.** Sub-pages cannot have their own link previews while the site
uses hash routing. `fleet-os.dev/#/docs/cli` sends only `fleet-os.dev/` to the
server, so a crawler always receives the homepage HTML and always renders the
homepage card. `useDocumentTitle` rewrites the OG tags in the DOM, which fixes
tab titles and history but changes nothing for Discord, Slack or X — none of
them execute JavaScript before reading meta tags. Per-page cards require path
routing plus a prerender step that writes real HTML per route.

## Accessibility

- A skip link (`.skip-link` in `src/index.css`) precedes the nav and targets
  `<main id="main" tabIndex={-1}>`.
- One focus ring for every interactive element, written as longhands so a
  failed custom property costs only the colour. `transition-property: none` on
  the focus rule is deliberate: Tailwind v4 includes `outline-color` in
  `transition-colors`, which would otherwise fade the ring in from the text
  colour.
- `.focus-inverse` on accent-filled buttons swaps the ring to the foreground
  colour so it reads against the green.
- The mobile menu traps Tab, closes on Escape and on `hashchange`, and stops
  Lenis rather than fighting it with overflow rules.

## Degradation

`src/lib/useCapability.js` decides whether WebGL runs at all. Reduced motion,
`saveData`, ≤2 cores or no WebGL context all fall back to `MeshStatic.jsx`.
Under `prefers-reduced-motion` the reveals keep opacity and drop translate and
stagger, Lenis never loads, the terminal prints instantly and the failover
simulation resolves without delays.
