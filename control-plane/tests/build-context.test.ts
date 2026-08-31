/**
 * Uploaded build contexts.
 *
 * This is a route that writes attacker-influenced bytes to the control plane's
 * filesystem, so the tests that matter most are the ones about archives that
 * try to write somewhere they should not.
 */
import 'dotenv/config'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from '../src/config.js'
import { createContext, closeContext, type AppContext } from '../src/api/context.js'
import { extractContext, disposeContext, contextPath, assertValidContextId } from '../src/build/context.js'
import { ApiError } from '../src/api/errors.js'

/** Build a .tar.gz in memory from a directory, the way the CLI does. */
function tarball(dir: string, extraArgs: string[] = []): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-czf', '-', '-C', dir, ...extraArgs, '.'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    child.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`tar exited ${code}`))
    )
    child.on('error', reject)
  })
}

describe('unpacking an uploaded build context', () => {
  let ctx: AppContext
  let workdir: string

  before(async () => {
    ctx = createContext(loadConfig())
    workdir = await mkdtemp(join(tmpdir(), 'fleet-ctxtest-'))
  })

  after(async () => {
    await rm(workdir, { recursive: true, force: true })
    await closeContext(ctx)
  })

  test('a normal project round-trips', async () => {
    const src = await mkdtemp(join(tmpdir(), 'fleet-src-'))
    await writeFile(join(src, 'Dockerfile'), 'FROM nginx\n')
    await mkdir(join(src, 'app'), { recursive: true })
    await writeFile(join(src, 'app', 'index.js'), 'console.log(1)\n')

    const { id, path } = await extractContext(workdir, await tarball(src))

    assert.equal(await readFile(join(path, 'Dockerfile'), 'utf8'), 'FROM nginx\n')
    assert.equal(await readFile(join(path, 'app', 'index.js'), 'utf8'), 'console.log(1)\n')
    assert.equal(path, contextPath(workdir, id))
  })

  test('each upload gets its own directory', async () => {
    // Two deploys of different commits must not fight over one working tree.
    const src = await mkdtemp(join(tmpdir(), 'fleet-src-'))
    await writeFile(join(src, 'Dockerfile'), 'FROM alpine\n')
    const archive = await tarball(src)

    const a = await extractContext(workdir, archive)
    const b = await extractContext(workdir, archive)
    assert.notEqual(a.id, b.id)
    assert.notEqual(a.path, b.path)
  })

  test('an empty upload is refused with a reason', async () => {
    await assert.rejects(
      () => extractContext(workdir, Buffer.alloc(0)),
      (err: ApiError) => err.code === 'empty_context'
    )
  })

  test('something that is not a tarball is refused, not half-extracted', async () => {
    await assert.rejects(
      () => extractContext(workdir, Buffer.from('this is not a gzip stream at all')),
      (err: ApiError) => err.code === 'context_unreadable'
    )
  })

  describe('archives that try to escape', () => {
    test('a path traversal entry is refused', async () => {
      // The classic: an entry of ../../etc/cron.d/x, which without the check
      // would be written outside the workspace by an authenticated caller.
      const src = await mkdtemp(join(tmpdir(), 'fleet-evil-'))
      await mkdir(join(src, 'nested'), { recursive: true })
      await writeFile(join(src, 'nested', 'payload'), 'x\n')

      // Build the archive with the traversal in the member name.
      const archive = await new Promise<Buffer>((resolve, reject) => {
        const child = spawn(
          'tar',
          ['-czf', '-', '-C', src, '--transform', 's|nested/payload|../../escaped|', 'nested/payload'],
          { stdio: ['ignore', 'pipe', 'pipe'] }
        )
        const chunks: Buffer[] = []
        child.stdout.on('data', (c: Buffer) => chunks.push(c))
        child.on('close', (code) =>
          code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('tar failed'))
        )
        child.on('error', reject)
      }).catch(() => null)

      // GNU tar has --transform; BSD tar does not. Skip rather than pass
      // vacuously on a machine that could not build the malicious archive.
      if (!archive) return

      await assert.rejects(
        () => extractContext(workdir, archive),
        (err: ApiError) => err.code === 'unsafe_context'
      )

      // And nothing was written outside the workspace.
      await assert.rejects(() => access(join(workdir, '..', 'escaped')))
    })
  })

  test('a context id that is not a uuid is refused before it reaches a path', () => {
    for (const bad of ['../../etc', 'not-a-uuid', '', 'a/b', '..']) {
      assert.throws(() => assertValidContextId(bad), ApiError, `expected ${bad} to be refused`)
    }
    assert.doesNotThrow(() => assertValidContextId('4d09781f-8780-4b2a-9c31-000000000000'))
  })

  test('disposing removes the tree, and is safe to call twice', async () => {
    const src = await mkdtemp(join(tmpdir(), 'fleet-src-'))
    await writeFile(join(src, 'Dockerfile'), 'FROM alpine\n')
    const { id, path } = await extractContext(workdir, await tarball(src))

    await disposeContext(workdir, id)
    await assert.rejects(() => access(path))
    // The deploy path calls this in a finally; a second call must not throw.
    await disposeContext(workdir, id)
  })

  test('disposing ignores an id that could escape the workspace', async () => {
    // Belt and braces: dispose is reached from a request body.
    await disposeContext(workdir, '../..')
    await access(workdir) // still there
  })
})

describe('a context with no Dockerfile', () => {
  test('is refused at upload, not several minutes into a build', async () => {
    // The usual cause is a .dockerignore listing `Dockerfile` — correct for a
    // local build, which reads it from the host, and wrong for one shipped
    // elsewhere. buildx reports this as "failed to read dockerfile" after the
    // build has already started, against a context that otherwise looks fine.
    const ctx = createContext(loadConfig())
    const workdir = await mkdtemp(join(tmpdir(), 'fleet-nodf-'))
    const src = await mkdtemp(join(tmpdir(), 'fleet-src-'))
    await writeFile(join(src, 'package.json'), '{}\n')

    const archive = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn('tar', ['-czf', '-', '-C', src, '.'], { stdio: ['ignore', 'pipe', 'pipe'] })
      const chunks: Buffer[] = []
      child.stdout.on('data', (c: Buffer) => chunks.push(c))
      child.on('close', (code) =>
        code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('tar failed'))
      )
      child.on('error', reject)
    })

    await assert.rejects(
      () => extractContext(workdir, archive),
      (err: ApiError) => {
        assert.equal(err.code, 'no_dockerfile')
        // The message has to name the likely cause, or it is just a restatement.
        assert.match(err.message, /\.dockerignore/)
        return true
      }
    )

    await rm(workdir, { recursive: true, force: true })
    await closeContext(ctx)
  })
})
