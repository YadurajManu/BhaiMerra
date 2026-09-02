/**
 * Emit a real HTML file for every route, after vite build.
 *
 * The site is a single-page app behind hash routing, which means a crawler
 * asking for /docs/fleet-yaml receives the same 3KB shell and the same <title>
 * as the homepage. Twenty pages of documentation — the spec, the scheduler,
 * self-hosting, the parts people actually search for — do not exist as far as
 * a search engine is concerned.
 *
 * This is not server rendering. The page content already lives in pages.js as
 * structured data, so it can be walked and written out as static HTML at build
 * time. The React app still boots on top and takes over; what changes is that
 * there is something real underneath it.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')

const { PAGES, PAGE_ORDER } = await import(join(root, 'src/lib/pages.js'))

/** The origin everything canonicalises to. */
const ORIGIN = process.env.SITE_ORIGIN?.replace(/\/$/, '') || 'https://fleet.plastikworld.xyz'

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c])

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** Rewrite an in-app hash link to a real path so crawlers can follow it. */
const href = (h) => (typeof h === 'string' && h.startsWith('#/') ? `/${h.slice(2)}` : h)

/**
 * Render one content block.
 *
 * Mirrors PageShell's block types. The markup is plain and unstyled on purpose:
 * it exists to be read by a crawler and by anyone with JavaScript disabled, and
 * the React app replaces it wholesale a moment later.
 */
function block(b) {
  switch (b.t) {
    case 'h':
      return `<h2 id="${esc(slug(b.text))}">${esc(b.text)}</h2>`
    case 'p':
      return `<p>${esc(b.text)}</p>`
    case 'list':
      return `<ul>${b.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
    case 'code':
      return `<pre><code>${b.lines.map(esc).join('\n')}</code></pre>`
    case 'kv':
      return `<dl>${b.rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`
    case 'table':
      return (
        `<table><thead><tr>${b.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>` +
        b.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('') +
        `</tbody></table>`
      )
    case 'note':
      return `<aside><strong>${b.tone === 'warn' ? 'Careful' : 'Note'}:</strong> ${esc(b.text)}</aside>`
    case 'links':
      // Internal links matter: this is how a crawler discovers the rest.
      return `<ul>${b.items
        .map(([label, h, desc]) => `<li><a href="${esc(href(h))}">${esc(label)}</a> — ${esc(desc)}</li>`)
        .join('')}</ul>`
    case 'status':
      return `<ul>${b.rows.map(([n, s, u]) => `<li>${esc(n)}: ${esc(s)} (${esc(u)})</li>`).join('')}</ul>`
    default:
      return ''
  }
}

/**
 * Structured data. Documentation pages describe themselves as TechArticle, which
 * is what earns a rich result rather than a bare blue link.
 */
function jsonLd(route, page) {
  const url = `${ORIGIN}/${route}`
  const isDoc = route.startsWith('docs')
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': isDoc ? 'TechArticle' : 'WebPage',
    headline: page.title,
    description: page.lede,
    url,
    inLanguage: 'en',
    isPartOf: { '@type': 'WebSite', name: 'Fleet OS', url: ORIGIN },
    author: { '@type': 'Person', name: 'Yaduraj Singh', url: 'https://yaduraj.me' },
    ...(isDoc ? { proficiencyLevel: 'Beginner', dependencies: 'Docker' } : {}),
  })
}

function crumbs(route, page) {
  const parts = route.split('/')
  const items = [{ name: 'Fleet OS', item: ORIGIN }]
  if (parts.length > 1) items.push({ name: page.group, item: `${ORIGIN}/${parts[0]}` })
  items.push({ name: page.title, item: `${ORIGIN}/${route}` })
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((x, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: x.name,
      item: x.item,
    })),
  })
}

const shell = await readFile(join(dist, 'index.html'), 'utf8')

function pageHtml(route, page) {
  const url = `${ORIGIN}/${route}`
  const title = `${page.title} — Fleet OS`

  const head = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(page.lede)}" />`,
    `<link rel="canonical" href="${esc(url)}" />`,
    `<meta property="og:type" content="article" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(page.lede)}" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(page.lede)}" />`,
    `<script type="application/ld+json">${jsonLd(route, page)}</script>`,
    `<script type="application/ld+json">${crumbs(route, page)}</script>`,
  ].join('\n    ')

  const body =
    `<main id="prerendered">` +
    `<nav><a href="/">Fleet OS</a> / ${esc(page.group)}</nav>` +
    `<article>` +
    `<h1>${esc(page.title)}</h1>` +
    `<p>${esc(page.lede)}</p>` +
    page.blocks.map(block).join('\n') +
    `</article>` +
    // Every page links to every other. With hash routing there was no crawl
    // path between them at all.
    `<nav aria-label="All pages"><ul>` +
    PAGE_ORDER.map((r) => `<li><a href="/${r}">${esc(PAGES[r].title)}</a></li>`).join('') +
    `</ul></nav>` +
    `</main>`

  let html = shell
    // Replace the homepage's meta with this page's, rather than appending a
    // second <title> that browsers and crawlers resolve inconsistently.
    .replace(/<title>[\s\S]*?<\/title>/, '')
    .replace(/<meta name="description"[\s\S]*?\/>/, '')
    .replace(/<link rel="canonical"[\s\S]*?\/>/, '')
    .replace(/<meta property="og:url"[\s\S]*?\/>/, '')
    .replace(/<meta property="og:title"[\s\S]*?\/>/, '')
    .replace(/<meta property="og:description"[\s\S]*?\/>/, '')
    .replace(/<meta name="twitter:title"[\s\S]*?\/>/, '')
    .replace(/<meta name="twitter:description"[\s\S]*?\/>/, '')
    .replace('</head>', `  ${head}\n  </head>`)

  // Inside #root, not beside it. createRoot().render() clears its container,
  // so React removes this the moment it mounts. Putting it alongside would
  // leave a reader looking at the app and a duplicate of the same page
  // underneath it.
  html = html.replace('<div id="root"></div>', `<div id="root">${body}</div>`)
  return html
}

let written = 0
for (const route of PAGE_ORDER) {
  const page = PAGES[route]
  if (!page) continue
  const dir = join(dist, route)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'index.html'), pageHtml(route, page), 'utf8')
  written++
}

/* ── sitemap ─────────────────────────────────────────────────────────
   Without this nothing tells a search engine these pages exist, and with
   hash routing nothing could have. */
const today = new Date().toISOString().slice(0, 10)
const urls = [
  { loc: `${ORIGIN}/`, priority: '1.0', freq: 'weekly' },
  { loc: `${ORIGIN}/founder`, priority: '0.6', freq: 'monthly' },
  ...PAGE_ORDER.map((r) => ({
    loc: `${ORIGIN}/${r}`,
    priority: r.startsWith('docs') ? '0.9' : r.startsWith('legal') ? '0.3' : '0.6',
    freq: r.startsWith('legal') ? 'yearly' : 'monthly',
  })),
]
await writeFile(
  join(dist, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls
      .map(
        (u) =>
          `  <url><loc>${u.loc}</loc><lastmod>${today}</lastmod>` +
          `<changefreq>${u.freq}</changefreq><priority>${u.priority}</priority></url>`
      )
      .join('\n') +
    `\n</urlset>\n`,
  'utf8'
)

await writeFile(
  join(dist, 'robots.txt'),
  [
    '# Fleet OS',
    'User-agent: *',
    'Allow: /',
    '',
    '# Nothing here is private, but these are noise in an index.',
    'Disallow: /healthz',
    '',
    `Sitemap: ${ORIGIN}/sitemap.xml`,
    '',
  ].join('\n'),
  'utf8'
)

if (!existsSync(join(dist, 'sitemap.xml'))) throw new Error('sitemap was not written')
console.log(`prerendered ${written} pages, sitemap with ${urls.length} urls, robots.txt`)
