/**
 * Uploaded build contexts.
 *
 * `build:` used to work only for a git push, because that is the one path that
 * produces a checkout on the control plane's disk. A deploy from a laptop had
 * nowhere to build from, so the answer was "build the image yourself, tag it
 * for a registry the nodes can reach, push it, and reference it by digest" —
 * four manual steps and an architecture mistake waiting to happen.
 *
 * This is the other half: the CLI sends the directory, and Fleet builds it the
 * same way it builds a pushed commit, for every architecture its nodes have.
 */
import { spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { ApiError } from '../api/errors.js'

/** Big enough for a real repository, small enough that a stray node_modules is caught. */
export const MAX_CONTEXT_BYTES = 256 * 1024 * 1024

const UPLOAD_DIR = 'uploads'

export type UploadedContext = {
  id: string
  /** Absolute path the builder uses as its context root. */
  path: string
}

/** Where an upload lives. Separate from `checkouts/` so cleanup cannot confuse them. */
export function contextPath(workdir: string, id: string): string {
  return join(workdir, UPLOAD_DIR, id)
}

/**
 * A context id reaches the filesystem, so it is generated here and validated on
 * the way back in. Anything that is not a plain uuid is refused rather than
 * escaped — there is no legitimate caller that needs one.
 */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function assertValidContextId(id: string): void {
  if (!ID.test(id)) {
    throw ApiError.badRequest('invalid_context', 'That is not a build context id')
  }
}

/**
 * Unpack an uploaded tar.gz into its own directory.
 *
 * The archive is listed before it is extracted. tar strips leading slashes and
 * skips `..` entries on both GNU and BSD, but it does so with a warning and a
 * non-zero-ish outcome that is easy to miss — and this is a path where a
 * malicious archive would be writing to the control plane's filesystem. Reading
 * the table of contents first turns that from "probably handled" into a refusal
 * with a reason.
 */
export async function extractContext(
  workdir: string,
  archive: Buffer
): Promise<UploadedContext> {
  if (archive.length === 0) {
    throw ApiError.badRequest('empty_context', 'The build context archive is empty')
  }
  if (archive.length > MAX_CONTEXT_BYTES) {
    throw ApiError.unprocessable(
      'context_too_large',
      `The build context is ${Math.round(archive.length / 1024 / 1024)}MB, over the ${MAX_CONTEXT_BYTES / 1024 / 1024}MB limit. Add a .dockerignore — node_modules and .git are almost never needed to build an image.`
    )
  }

  const listing = await runTar(['-tzf', '-'], undefined, archive)
  for (const raw of listing.split('\n')) {
    const entry = raw.trim()
    if (!entry) continue
    if (entry.startsWith('/') || entry.startsWith('~')) {
      throw ApiError.unprocessable('unsafe_context', `The archive contains an absolute path: ${entry}`)
    }
    if (entry.split('/').includes('..')) {
      throw ApiError.unprocessable('unsafe_context', `The archive escapes its own directory: ${entry}`)
    }
  }

  const id = randomUUID()
  const path = contextPath(workdir, id)
  await mkdir(path, { recursive: true })

  // --no-same-owner: the archive records the uploader's uids, which mean
  // nothing here and would fail as a non-root process anyway.
  await runTar(['-xzf', '-', '-C', path, '--no-same-owner'], path, archive)

  return { id, path }
}

/**
 * Delete an extracted context.
 *
 * Called on both the success and failure paths: customer source is held only
 * for as long as it takes to build it, and a control plane that keeps every
 * upload fills its disk in a week.
 */
export async function disposeContext(workdir: string, id: string): Promise<void> {
  if (!ID.test(id)) return
  await rm(contextPath(workdir, id), { recursive: true, force: true }).catch(() => {})
}

function runTar(args: string[], cwd: string | undefined, input: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(ApiError.unprocessable('context_unreadable', 'Unpacking the build context timed out'))
    }, 120_000)

    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()))
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()))

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(ApiError.unprocessable('context_unreadable', `Could not run tar: ${err.message}`))
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) return resolve(stdout)
      const detail = stderr.trim().split('\n').slice(-3).join(' ')
      reject(
        ApiError.unprocessable(
          'context_unreadable',
          `The build context is not a readable .tar.gz${detail ? `: ${detail}` : ''}`
        )
      )
    })

    child.stdin.on('error', () => {
      /* tar exited early; the close handler reports why */
    })
    child.stdin.end(input)
  })
}
