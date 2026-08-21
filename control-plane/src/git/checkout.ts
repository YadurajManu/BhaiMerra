import { spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export class CheckoutError extends Error {}

/**
 * Fetch a repository at a specific commit into the build workspace.
 *
 * A shallow fetch of one commit, not a full clone: the build only needs the
 * tree at that sha, and a homelab control plane should not keep the history
 * of every repo it has ever built.
 */
export async function checkoutRepo(opts: {
  repoUrl: string
  gitSha: string
  workdir: string
  timeoutMs?: number
}): Promise<{ path: string; relative: string; dispose: () => Promise<void> }> {
  if (!/^[0-9a-f]{7,40}$/i.test(opts.gitSha)) {
    // The sha reaches a command line; anything that is not a sha is refused
    // rather than escaped, because there is no legitimate case for it.
    throw new CheckoutError(`"${opts.gitSha}" is not a git sha`)
  }
  assertSafeRemote(opts.repoUrl)
  const safeRemote = redactRemote(opts.repoUrl)

  // One directory per repo+sha, so concurrent deploys of different commits do
  // not fight over the same working tree.
  const key = createHash('sha256').update(`${opts.repoUrl}@${opts.gitSha}`).digest('hex').slice(0, 16)
  const relative = join('checkouts', key)
  const path = join(opts.workdir, relative)

  await rm(path, { recursive: true, force: true })
  await mkdir(path, { recursive: true })

  const timeoutMs = opts.timeoutMs ?? 5 * 60_000
  await run('git', ['init', '--quiet'], path, timeoutMs)
  await run('git', ['remote', 'add', 'origin', opts.repoUrl], path, timeoutMs)
  await run('git', ['fetch', '--depth', '1', '--quiet', 'origin', opts.gitSha], path, timeoutMs)
  await run('git', ['checkout', '--quiet', 'FETCH_HEAD'], path, timeoutMs)

  void safeRemote
  return {
    path,
    relative,
    // The caller deletes the tree once the image is built. We hold customer
    // source only for as long as it takes to build it, which is what the
    // privacy notice says, and it keeps the disk from filling with checkouts.
    dispose: () => rm(path, { recursive: true, force: true }),
  }
}

/**
 * Remotes come from user input and are handed to git, which will happily run
 * `ext::sh -c ...` as a transport. Only ordinary fetchable URLs are allowed.
 */
/**
 * Strip credentials before a URL reaches a log or an error message. An
 * installation token embedded in a clone URL is a live credential, and git
 * puts the remote into its own error output.
 */
export function redactRemote(url: string): string {
  return url.replace(/\/\/[^@/]+@/, '//***@')
}

export function assertSafeRemote(repoUrl: string): void {
  const allowed = /^(https:\/\/|git@[a-z0-9.-]+:)/i
  if (!allowed.test(repoUrl)) {
    throw new CheckoutError(
      `Refusing to fetch from "${repoUrl}". Use an https:// URL or git@host:path.`
    )
  }
  if (/[\s;|&`$]/.test(repoUrl)) {
    throw new CheckoutError('Repository URL contains characters that are not valid in a remote')
  }
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      // Never let git stop to ask for a password on a server.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' },
    })
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new CheckoutError(`git ${args[0]} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()))
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new CheckoutError(`could not run git: ${err.message}`))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) return resolve()
      // git echoes the remote in its errors, token and all.
      const detail = stderr.trim().split('\n').slice(-3).join(' ').replace(/\/\/[^@\s/]+@/g, '//***@')
      reject(new CheckoutError(`git ${args[0]} failed: ${detail}`))
    })
  })
}
