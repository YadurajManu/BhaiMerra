import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Config } from '../config.js'
import { ApiError } from './errors.js'

/**
 * A self-hosted control plane has no CDN behind it, so it serves its own
 * installer and agent binaries. Otherwise the pairing command points at a
 * download host that only exists for the hosted product, and every
 * self-hosted install fails at the first step.
 */

const ARCHES = new Set(['arm64', 'armv7', 'amd64'])
const PLATFORMS = new Set(['linux', 'darwin', 'windows'])

/** The public origin of *this* control plane, as the caller reached it. */
export function publicOrigin(req: FastifyRequest): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() ?? req.protocol
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host
  return `${proto}://${host}`
}

/**
 * Agents call the API at its root, unlike browsers which may reach it through
 * the dashboard's /api reverse proxy. Prefer the explicitly configured public
 * API address so a dashboard-issued installer cannot teach an agent the wrong
 * origin (and receive nginx's 405 on POST /agent/register).
 */
export function publicApiOrigin(req: FastifyRequest, config: Pick<Config, 'PUBLIC_API_URL'>): string {
  return config.PUBLIC_API_URL?.replace(/\/+$/, '') ?? publicOrigin(req)
}

export async function installRoutes(app: FastifyInstance) {
  const scriptPath = app.ctx.config.INSTALL_SCRIPT_PATH
  const binDir = app.ctx.config.AGENT_BIN_DIR

  /**
   * The install script, with this control plane's address substituted in.
   * Curl-pipe-sh is the documented flow, so the script has to arrive already
   * pointed at the right server rather than needing flags the user must know.
   */
  app.get('/install', async (req, reply) => {
    let script: string
    try {
      script = await readFile(scriptPath, 'utf8')
    } catch {
      throw new ApiError(
        503,
        'installer_unavailable',
        'This control plane has no install script bundled. Build the agent and mount it, ' +
          'or install the agent manually — see docs/self-hosting.md.'
      )
    }

    const origin = publicApiOrigin(req, app.ctx.config)

    // Rewrite the default in each assignment, leaving anything after it (a
    // trailing comment) alone. Anchoring to end-of-line broke the moment a
    // comment was added to those lines.
    const setDefault = (text: string, name: string, value: string) =>
      text.replace(
        new RegExp(`^(${name}="\\$\\{[A-Z_]+:-)[^}]*(\\}")`, 'm'),
        `$1${value}$2`
      )

    script = setDefault(script, 'CONTROL_PLANE', origin)
    script = setDefault(script, 'DOWNLOAD_BASE', `${origin}/install`)

    if (!script.includes(origin)) {
      // Serving an installer that points somewhere else is worse than not
      // serving one: it fails on the user's machine, not here.
      throw new ApiError(
        500,
        'installer_not_templated',
        'The install script could not be pointed at this control plane. Its CONTROL_PLANE ' +
          'and DOWNLOAD_BASE assignments may have changed shape.'
      )
    }

    return reply
      .type('text/x-shellscript; charset=utf-8')
      // Anything piped into a shell must never be served from a cache that
      // could hand out a stale or half-written copy.
      .header('cache-control', 'no-store')
      .send(script)
  })

  /** Agent binaries, named the way the install script asks for them. */
  app.get('/install/fleet-agent-*', async (req, reply) => {
    const filename = (req.url.split('/install/')[1] || '').split('?')[0]
    if (!filename || filename.includes('..') || filename.includes('/')) {
      throw ApiError.badRequest('invalid_asset', 'Invalid agent asset name')
    }

    const file = join(binDir, filename)
    try {
      const info = await stat(file)
      return reply
        .type('application/octet-stream')
        .header('content-length', String(info.size))
        .header('cache-control', 'public, max-age=300')
        .send(createReadStream(file))
    } catch {
      throw new ApiError(
        404,
        'agent_build_missing',
        `No ${filename} build found on this control plane.`
      )
    }
  })

  app.get('/install/SHA256SUMS', async (_req, reply) => {
    try {
      return reply.type('text/plain').send(await readFile(join(binDir, 'SHA256SUMS'), 'utf8'))
    } catch {
      // Not fatal: the installer warns and continues when checksums are absent.
      throw ApiError.notFound('Checksums')
    }
  })

  /** What this control plane can actually hand out. */
  app.get('/install/manifest', async (req) => {
    const available: string[] = []
    for (const platform of PLATFORMS) {
      for (const arch of ARCHES) {
        try {
          await stat(join(binDir, `fleet-agent-${platform}-${arch}`))
          available.push(`${platform}/${arch}`)
        } catch {
          /* not built */
        }
      }
    }
    return { control_plane: publicApiOrigin(req, app.ctx.config), agents: available }
  })
}
