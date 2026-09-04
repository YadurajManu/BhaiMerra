import { parseDocument, isMap } from 'yaml'

/**
 * A review expressed as edits rather than as a rewritten manifest.
 *
 * The whole-manifest form has three costs that only show up in use. The model
 * has to reproduce every line it is not changing, which is most of them, and
 * any slip there is a silent regression — it removed a `build:` that way and
 * deployed a bare nginx over somebody's site. It cannot be done per service,
 * because each pass would return a manifest missing the others. And a
 * round-trip through parse and re-serialise destroys the comments `init`
 * wrote, which are the only explanation a generated file carries.
 *
 * Edits fix all three. A pass returns what it wants changed and nothing else,
 * so a service it was not shown cannot be damaged; the passes compose; and the
 * document is edited in place, so comments and layout survive untouched.
 */

export type Edit = {
  service: string
  field: string
  /** null removes the field — how a wrong health check gets taken out. */
  value: string | number | boolean | null
  why: string
}

/** Fields a review may change. Anything else is refused, not applied. */
const EDITABLE = new Set([
  'container_port',
  'health',
  'resources',
  'placement',
  'replicas',
  'env',
  'command',
])

/**
 * Fields it may never change, and why each one is dangerous.
 *
 * `node` names a machine, which no repository knows about — a review invented
 * one from a compose service name. `build` and `image` decide where the code
 * comes from; swapping build for image deployed a public nginx in place of a
 * site. `uses` and `volume` decide placement and data, and getting either
 * wrong moves a database away from its disk.
 */
const FORBIDDEN = new Set(['node', 'build', 'image', 'uses', 'volume', 'name'])

/**
 * The shape the manifest wants, from the shape a model naturally writes.
 *
 * `health: /healthz` is the obvious way to say it and the manifest wants
 * `health: { path: /healthz }`. Without this the whole review is discarded —
 * the merged manifest fails the parser and the draft is kept — over a
 * difference in spelling that costs one line to accept. Only for fields where
 * the short form is unambiguous; anything else is passed through and stands or
 * falls on the parser.
 */
function shape(field: string, value: Edit['value']): unknown {
  if (field === 'health' && typeof value === 'string') return { path: value }
  return value
}

export type ApplyResult = {
  manifest: string
  applied: Edit[]
  refused: Array<{ edit: Edit; reason: string }>
}

/**
 * Apply edits to a manifest, keeping everything they do not mention.
 *
 * Edited as a document rather than an object: `init` writes comments
 * explaining what it could not determine, and a service carrying "# No health
 * check: container state decides whether this is up" loses the one thing
 * telling the reader why, the moment the file is rebuilt from parsed values.
 */
export function applyEdits(manifest: string, edits: Edit[]): ApplyResult {
  const doc = parseDocument(manifest)
  const applied: Edit[] = []
  const refused: Array<{ edit: Edit; reason: string }> = []

  const services = doc.get('services')
  if (!isMap(services)) {
    return { manifest, applied, refused: edits.map((edit) => ({ edit, reason: 'no services block' })) }
  }

  for (const edit of edits) {
    if (FORBIDDEN.has(edit.field)) {
      refused.push({ edit, reason: `"${edit.field}" is not something a repository can decide` })
      continue
    }
    if (!EDITABLE.has(edit.field)) {
      refused.push({ edit, reason: `"${edit.field}" is not an editable field` })
      continue
    }
    if (!services.has(edit.service)) {
      // A service the manifest does not have. Adding one from a review would
      // deploy something nobody asked for.
      refused.push({ edit, reason: `no service named "${edit.service}"` })
      continue
    }

    if (edit.value === null) {
      doc.deleteIn(['services', edit.service, edit.field])
    } else {
      doc.setIn(['services', edit.service, edit.field], shape(edit.field, edit.value))
    }
    applied.push(edit)
  }

  return { manifest: applied.length ? String(doc) : manifest, applied, refused }
}

/** Pull the edits out of a reply that may be fenced or padded with prose. */
export function parseEdits(content: string): { edits: Edit[]; questions: unknown[] } {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = (fenced?.[1] ?? content).trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('the model did not return JSON')

  const parsed = JSON.parse(raw.slice(start, end + 1)) as { edits?: unknown; questions?: unknown }

  // A malformed edit is dropped rather than failing the pass: the others are
  // still good, and one bad entry should not cost a whole service's review.
  const edits: Edit[] = Array.isArray(parsed.edits)
    ? (parsed.edits as unknown[])
        .filter((e): e is Edit => {
          const c = e as Partial<Edit>
          return (
            typeof c?.service === 'string' &&
            typeof c?.field === 'string' &&
            typeof c?.why === 'string' &&
            (c.value === null ||
              typeof c.value === 'string' ||
              typeof c.value === 'number' ||
              typeof c.value === 'boolean' ||
              (typeof c.value === 'object' && c.value !== null))
          )
        })
        .slice(0, 8)
    : []

  return { edits, questions: Array.isArray(parsed.questions) ? parsed.questions : [] }
}
