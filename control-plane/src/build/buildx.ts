import { spawn } from 'node:child_process'
import { access, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { BuildProgress, BuildRequest, BuildResult, BuildRunner } from './runner.js'
import { BuildUnavailableError } from './runner.js'

/**
 * Multi-arch builds with Docker Buildx (FR-3, tech doc §3).
 *
 * Builds run centrally for v1 so a Pi never has to compile anything. The
 * resulting manifest list carries every architecture the fleet needs, and each
 * agent pulls whichever one matches its own.
 */
export class BuildxRunner implements BuildRunner {
  readonly name = 'buildx'

  constructor(
    private readonly opts: {
      registry?: string
      /** "username:password" for a registry that requires them. */
      credentials?: string
      builder?: string
      /** Root the build context must stay inside. */
      workdir: string
      /** Skip `--push` and load locally instead; used when no registry is set. */
      pushToRegistry?: boolean
      timeoutMs?: number
      /**
       * How much build cache to export. "max" caches intermediate stages and
       * gives the best reuse; "min" caches only the final image's layers and
       * uploads far less, which matters when the registry sits behind a proxy
       * with a request size limit. "off" skips the export entirely.
       */
      cacheMode?: 'max' | 'min' | 'off'
      log?: (line: string) => void
    }
  ) {}

  async available(): Promise<boolean> {
    try {
      await run('docker', ['buildx', 'version'], { timeoutMs: 5000 })
      return true
    } catch {
      return false
    }
  }

  /** Platforms the local builder can actually target. */
  async supportedPlatforms(): Promise<string[]> {
    try {
      const { stdout } = await run('docker', ['buildx', 'inspect', '--bootstrap'], { timeoutMs: 60_000 })
      const line = stdout.split('\n').find((l) => l.trim().toLowerCase().startsWith('platforms:'))
      if (!line) return []
      return line
        .slice(line.indexOf(':') + 1)
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
    } catch {
      return []
    }
  }

  /**
   * Authenticate against the registry before pushing.
   *
   * A registry reachable from outside the LAN has to require credentials, and
   * `REGISTRY_CREDENTIALS` has been in the config schema since the beginning
   * without anything reading it — so a push to an authenticated registry
   * failed with a 401 that looked like a build error.
   *
   * The password goes in on stdin. As an argument it would be visible in `ps`
   * to every user on the host and recorded in any process accounting.
   */
  private async login(): Promise<void> {
    const credentials = this.opts.credentials
    const registry = this.opts.registry
    if (!credentials || !registry) return

    const separator = credentials.indexOf(':')
    if (separator < 1) {
      throw new BuildUnavailableError(
        'REGISTRY_CREDENTIALS must be "username:password"'
      )
    }
    const username = credentials.slice(0, separator)
    const password = credentials.slice(separator + 1)

    // `run` resolves with the exit code rather than throwing on a non-zero
    // one, so a failed login has to be checked for, not caught.
    let code: number
    try {
      ;({ code } = await run(
        'docker',
        ['login', registry, '--username', username, '--password-stdin'],
        { timeoutMs: 30_000, stdin: password }
      ))
    } catch {
      code = 1
    }

    if (code !== 0) {
      // Deliberately does not include docker's output: it echoes the registry
      // address and can include the credential on some versions.
      throw new BuildUnavailableError(
        `could not sign in to the registry at ${registry} as "${username}". Check REGISTRY_CREDENTIALS.`
      )
    }
  }

  async build(req: BuildRequest): Promise<BuildResult> {
    if (!(await this.available())) {
      throw new BuildUnavailableError('docker buildx is not available on the control plane host')
    }
    await this.login()

    const context = await this.resolveContext(req.buildContext, req.contextRoot)

    // Refuse rather than silently building fewer architectures than the fleet
    // needs: a node would otherwise fail to pull an image that looks fine.
    const supported = await this.supportedPlatforms()
    const missing = req.platforms.filter((p) => !supported.includes(p))
    if (supported.length && missing.length) {
      throw new BuildUnavailableError(
        `this builder cannot target ${missing.join(', ')}. ` +
          `Install QEMU emulators (docker run --privileged --rm tonistiigi/binfmt --install all) ` +
          `or remove those architectures from the fleet. Supported: ${supported.join(', ')}.`
      )
    }

    const tag = this.tagFor(req)
    const args = [
      'buildx', 'build',
      '--platform', req.platforms.join(','),
      '--tag', tag,
      '--label', `org.opencontainers.image.revision=${req.gitSha}`,
      '--label', 'org.opencontainers.image.source=fleet-os',
      '--progress', 'plain',
    ]

    if (this.opts.builder) args.push('--builder', this.opts.builder)

    if (this.opts.pushToRegistry !== false && this.opts.registry) {
      args.push('--push')

      // Build cache is an optimisation, and it is exported *after* the image
      // has already been pushed. Letting a failed cache upload fail the whole
      // build throws away a perfectly good image — which is exactly what
      // happened behind Cloudflare, whose free plan rejects request bodies
      // over 100MB with a 413 and took the deploy down with it.
      //
      // ignore-error keeps that a slow build next time instead of a failed one
      // now. mode is configurable because "max" exports every intermediate
      // stage, which is the version most likely to exceed such a limit.
      const cacheMode = this.opts.cacheMode ?? 'max'
      if (cacheMode !== 'off') {
        args.push(
          '--cache-to',
          `type=registry,ref=${repositoryOf(tag)}:buildcache,mode=${cacheMode},ignore-error=true`
        )
      }
    } else {
      // A multi-platform build cannot be --load into the local daemon, so
      // without a registry only a single-platform build is possible.
      if (req.platforms.length > 1) {
        throw new BuildUnavailableError(
          'a multi-architecture build needs a registry to push to; set REGISTRY_URL'
        )
      }
      args.push('--load')
    }

    args.push(context)

    const started = Date.now()
    // Only walk the output when something is listening: the split-and-parse is
    // cheap per line, but a large build emits thousands of them.
    const watching = Boolean(this.opts.log || req.onProgress)
    const { stdout, stderr, code } = await run('docker', args, {
      timeoutMs: this.opts.timeoutMs ?? 20 * 60_000,
      onLine: watching
        ? (line) => {
            this.opts.log?.(line)
            if (!req.onProgress) return
            const progress = parseBuildLine(line)
            if (progress) req.onProgress(progress)
          }
        : undefined,
    })

    if (code !== 0) {
      // The last few lines are what a user needs; the whole log is noise.
      const tail = (stderr || stdout).trim().split('\n').slice(-12).join('\n')
      throw new BuildUnavailableError(`buildx failed for "${req.serviceName}":\n${tail}`)
    }

    return {
      imageTags: [tag],
      digest: extractDigest(stderr + stdout) ?? undefined,
      logUrl: undefined,
      durationMs: Date.now() - started,
    } as BuildResult & { durationMs: number }
  }

  private tagFor(req: BuildRequest): string {
    const registry = (this.opts.registry ?? req.registry ?? '').replace(/\/+$/, '')
    const name = `${req.serviceName}:${req.gitSha.slice(0, 12)}`
    return registry ? `${registry}/${name}` : name
  }

  /**
   * Keep the build context inside the configured workdir. A manifest is user
   * input, and "build: ../../../etc" must not be a way to read the host.
   */
  private async resolveContext(buildContext: string, contextRoot?: string): Promise<string> {
    // A webhook checkout lands outside the configured workspace, so the root
    // travels with the request; the containment check still applies to it.
    const resolved = containedContext(contextRoot ?? this.opts.workdir, buildContext)
    try {
      await access(resolved)
      const info = await stat(resolved)
      if (!info.isDirectory()) throw new Error('not a directory')
    } catch {
      throw new BuildUnavailableError(`build context "${buildContext}" does not exist in the checkout`)
    }
    return resolved
  }
}

/**
 * Where a build context resolves to, and a refusal if it leaves its root.
 *
 * Pure and exported so the two shapes can be pinned down in a test. They are
 * genuinely different and confusing them is a real bug: a checkout is a whole
 * repository and the manifest's path selects a directory inside it, whereas an
 * upload *is* the directory — the CLI resolved the path before packing, so the
 * context is "." and joining the path on again looks for ./api inside ./api.
 */
export function containedContext(base: string, buildContext: string): string {
  const resolved = join(base, buildContext)
  const root = base.replace(/\/+$/, '')
  if (resolved !== root && !resolved.startsWith(root + '/')) {
    throw new BuildUnavailableError(`build context "${buildContext}" escapes the workspace root`)
  }
  return resolved
}

/**
 * Strip the tag from an image reference.
 *
 * Splitting on the first colon is wrong the moment a registry has a port:
 * "localhost:5001/hello:abc" would yield "localhost", which resolves to Docker
 * Hub. Only a colon after the last slash is a tag separator.
 */
export function repositoryOf(imageRef: string): string {
  const slash = imageRef.lastIndexOf('/')
  const colon = imageRef.lastIndexOf(':')
  return colon > slash ? imageRef.slice(0, colon) : imageRef
}

function extractDigest(output: string): string | null {
  const match = /digest:\s*(sha256:[a-f0-9]{64})/i.exec(output)
  return match?.[1] ?? null
}

/** `#12 [linux/arm64 4/6] RUN npm ci` — the stage header, with an optional platform. */
const STEP_LINE = /^#\d+\s+\[([^\]]+)\]\s+(.+)$/
/** `#18 pushing manifest for …`, `#18 exporting layers 1.2s done` — no stage bracket. */
const PUSH_LINE = /^#\d+\s+((?:pushing|exporting)\b.*)$/i

/**
 * A progress detail is about to be shown in somebody's terminal, so it is
 * stripped of control characters — a Dockerfile is user input and a `RUN` line
 * carrying cursor escapes would corrupt the CLI's redraw region — and capped,
 * because this travels through Redis on every build.
 */
const sanitise = (text: string): string =>
  [...text]
    .map((ch) => (ch.codePointAt(0)! < 0x20 || ch.codePointAt(0)! === 0x7f ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)

/**
 * Turn one line of `--progress plain` output into a phase and a detail, or
 * nothing.
 *
 * Only the builder's own stage headers are recognised. Everything else — the
 * `#8 12.34 added 214 packages` echo of a step's stdout, `DONE`/`CACHED`
 * markers, `[auth]` lines naming registry credentials — is dropped rather than
 * forwarded, so what reaches the operator is the build's structure and not its
 * log.
 */
export function parseBuildLine(line: string): BuildProgress | null {
  const text = line.trim()

  // Push and export come first: they carry no stage bracket, so the step
  // pattern would never match them anyway.
  const push = PUSH_LINE.exec(text)
  if (push) {
    const detail = sanitise(push[1]!)
    return detail ? { phase: 'pushing', detail } : null
  }

  const step = STEP_LINE.exec(text)
  if (!step) return null

  const stage = step[1]!.trim()
  if (/^auth\b/i.test(stage)) return null

  const detail = sanitise(step[2]!)
  if (!detail) return null

  const counter = /(\d+)\/(\d+)\s*$/.exec(stage)
  const platform = /(linux\/[a-z0-9._/-]+)/i.exec(stage)?.[1]
  return {
    phase: 'building',
    ...(counter ? { step: Number(counter[1]), ofSteps: Number(counter[2]) } : {}),
    ...(platform ? { platform } : {}),
    detail,
  }
}

function run(
  command: string,
  args: string[],
  opts: { timeoutMs: number; onLine?: (line: string) => void; stdin?: string }
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })

    // stdin is always a pipe and always closed straight away. Closing it is
    // what 'ignore' would have achieved — the child reads EOF — and keeping
    // the shape fixed is what lets stdout and stderr be typed as streams.
    child.stdin.on('error', () => {
      /* the close handler reports why the process went away */
    })
    child.stdin.end(opts.stdin ?? '')
    // Let the streams do the UTF-8 decoding, so a chunk boundary falling inside
    // a multi-byte character cannot turn it into a replacement glyph.
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new BuildUnavailableError(`${command} timed out after ${opts.timeoutMs}ms`))
    }, opts.timeoutMs)

    // A chunk boundary also falls mid-line, so the tail of each stream is held
    // back until its newline arrives. Splitting the raw chunk instead would
    // report one line as two fragments, neither of which parses.
    const partial = { out: '', err: '' }
    const collect = (target: 'out' | 'err') => (chunk: string) => {
      if (target === 'out') stdout += chunk
      else stderr += chunk
      if (!opts.onLine) return
      const lines = (partial[target] + chunk).split('\n')
      partial[target] = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) opts.onLine(line)
    }

    child.stdout.on('data', collect('out'))
    child.stderr.on('data', collect('err'))

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // A final line with no trailing newline is still a line.
      if (opts.onLine)
        for (const rest of [partial.out, partial.err]) if (rest.trim()) opts.onLine(rest)
      resolve({ stdout, stderr, code: code ?? 1 })
    })
  })
}
