import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detect, manifestTemplate } from '../src/detect.js'

describe('framework detection', () => {
  let tmp: string

  test('detects Next.js project and generates standalone Dockerfile', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'fleet-test-next-'))
    try {
      await writeFile(join(tmp, 'package.json'), JSON.stringify({ dependencies: { next: '15.0.0', react: '19.0.0' } }))
      const d = await detect(tmp)
      assert.equal(d.framework, 'nextjs')
      assert.equal(d.port, 3000)
      assert.equal(d.healthPath, '/')
      assert.ok(d.dockerfile?.includes('.next/standalone'))
      assert.equal(d.hasDockerfile, false)

      const manifest = manifestTemplate('my-next-app', d)
      assert.ok(manifest.includes('build: .'))
      assert.ok(manifest.includes('container_port: 3000'))
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test('detects Vite project and generates nginx alpine Dockerfile', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'fleet-test-vite-'))
    try {
      await writeFile(join(tmp, 'package.json'), JSON.stringify({ devDependencies: { vite: '^6.0.0' } }))
      const d = await detect(tmp)
      assert.equal(d.framework, 'vite')
      assert.equal(d.port, 80)
      assert.equal(d.healthPath, '/')
      assert.ok(d.dockerfile?.includes('nginx:1.27-alpine'))

      const manifest = manifestTemplate('my-vite-app', d)
      assert.ok(manifest.includes('build: .'))
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test('detects Python FastAPI project', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'fleet-test-py-'))
    try {
      await writeFile(join(tmp, 'requirements.txt'), 'fastapi==0.115.0\nuvicorn==0.32.0\n')
      const d = await detect(tmp)
      assert.equal(d.framework, 'python')
      assert.equal(d.port, 8000)
      assert.ok(d.dockerfile?.includes('uvicorn'))
      assert.ok(d.label.includes('FastAPI'))
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test('detects Go project with go.mod', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'fleet-test-go-'))
    try {
      await writeFile(join(tmp, 'go.mod'), 'module github.com/user/myapi\n\ngo 1.24\n')
      const d = await detect(tmp)
      assert.equal(d.framework, 'go')
      assert.equal(d.port, 8080)
      assert.ok(d.dockerfile?.includes('golang:1.24-alpine'))
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test('detects Rust project with Cargo.toml', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'fleet-test-rust-'))
    try {
      await writeFile(join(tmp, 'Cargo.toml'), '[package]\nname = "myservice"\nversion = "0.1.0"\n')
      const d = await detect(tmp)
      assert.equal(d.framework, 'rust')
      assert.equal(d.port, 8080)
      assert.ok(d.dockerfile?.includes('cargo build --release'))
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test('preserves existing Dockerfile and detects its EXPOSE port', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'fleet-test-df-'))
    try {
      await writeFile(join(tmp, 'Dockerfile'), 'FROM alpine:latest\nEXPOSE 9000\nCMD ["./server"]\n')
      const d = await detect(tmp)
      assert.equal(d.hasDockerfile, true)
      assert.equal(d.dockerfile, null)
      assert.equal(d.port, 9000)

      const manifest = manifestTemplate('custom', d)
      assert.ok(manifest.includes('build: .'))
      assert.ok(manifest.includes('container_port: 9000'))
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})
