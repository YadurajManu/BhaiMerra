/**
 * Framework detection engine.
 *
 * Inspects the current working directory for well-known project signals and
 * returns everything `fleet init` needs to scaffold both a Dockerfile and a
 * fleet.yaml. Detection is deliberately shallow — fast, no child_process, no
 * network. A wrong guess is corrected with a one-line edit rather than a
 * five-minute hang.
 */
import { readFile, access } from 'node:fs/promises'
import { join, basename } from 'node:path'

export type Framework =
  | 'nextjs'
  | 'vite'
  | 'node'
  | 'python'
  | 'go'
  | 'rust'
  | 'static'
  | 'unknown'

export type Detection = {
  framework: Framework
  label: string
  port: number
  /**
   * Where to probe, or null when nothing here is worth probing.
   *
   * Null on purpose, and not a default of "/". A guessed path that is wrong
   * does not degrade to "no health check" -- it fails every probe for ever,
   * and the deploy then sits at "deploying" while the service runs and serves
   * traffic correctly. That is strictly worse than having no check at all,
   * where container state decides and the service comes up. So a path is
   * emitted only for frameworks that genuinely answer at the root; /health and
   * /healthz are conventions, not guarantees, and inventing one for an API
   * that does not implement it is how a working deploy gets stuck.
   */
  healthPath: string | null
  /** Dockerfile contents, or null when the project already has one. */
  dockerfile: string | null
  /** Whether a user-supplied Dockerfile already existed. */
  hasDockerfile: boolean
}

const exists = async (path: string) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const readJson = async (path: string): Promise<Record<string, unknown> | null> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

const readText = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** Extract EXPOSE port from an existing Dockerfile. */
function parseExpose(dockerfile: string): number | null {
  const match = dockerfile.match(/^EXPOSE\s+(\d+)/m)
  return match ? parseInt(match[1]!, 10) : null
}

const hasDep = (pkg: Record<string, unknown>, name: string): boolean => {
  const deps = pkg.dependencies as Record<string, string> | undefined
  const devDeps = pkg.devDependencies as Record<string, string> | undefined
  return Boolean(deps?.[name] || devDeps?.[name])
}

// ── Dockerfile templates ────────────────────────────────────────────────

const NEXTJS_DOCKERFILE = `# --- Build ---
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- Run ---
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
`

const VITE_DOCKERFILE = `# --- Build ---
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- Serve ---
FROM nginx:1.27-alpine
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
`

const NODE_DOCKERFILE = `FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "src/index.js"]
`

const PYTHON_DOCKERFILE = (
  entry: string,
  usesPoetry: boolean,
) => `FROM python:3.12-slim
WORKDIR /app
${
  usesPoetry
    ? `COPY pyproject.toml poetry.lock* ./
RUN pip install --no-cache-dir poetry && poetry config virtualenvs.create false && poetry install --no-interaction --no-ansi --no-dev`
    : `COPY requirements*.txt ./
RUN pip install --no-cache-dir -r requirements.txt`
}
COPY . .
EXPOSE 8000
CMD ["python", "-m", "${entry}"]
`

const GO_DOCKERFILE = (module: string) => `# --- Build ---
FROM golang:1.24-alpine AS builder
WORKDIR /app
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /server .

# --- Run ---
FROM alpine:3.21
COPY --from=builder /server /server
EXPOSE 8080
CMD ["/server"]
`

const RUST_DOCKERFILE = `# --- Build ---
FROM rust:1.87-slim AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock* ./
RUN mkdir src && echo 'fn main(){}' > src/main.rs && cargo build --release && rm -rf src
COPY . .
RUN cargo build --release

# --- Run ---
FROM debian:bookworm-slim
COPY --from=builder /app/target/release/* /usr/local/bin/app
EXPOSE 8080
CMD ["app"]
`

// ── Detection logic ─────────────────────────────────────────────────────

export async function detect(cwd: string = process.cwd()): Promise<Detection> {
  const hasDockerfile = await exists(join(cwd, 'Dockerfile'))

  // When a Dockerfile already exists, read its EXPOSE and skip auto-generation.
  if (hasDockerfile) {
    const df = await readText(join(cwd, 'Dockerfile'))
    const port = (df && parseExpose(df)) || 3000
    return {
      framework: 'unknown',
      label: 'existing Dockerfile',
      port,
      healthPath: null,
      dockerfile: null,
      hasDockerfile: true,
    }
  }

  // ── Node-based frameworks ──
  const pkg = await readJson(join(cwd, 'package.json'))
  if (pkg) {
    // Next.js
    if (hasDep(pkg, 'next')) {
      return {
        framework: 'nextjs',
        label: 'Next.js',
        port: 3000,
        healthPath: '/',
        dockerfile: NEXTJS_DOCKERFILE,
        hasDockerfile: false,
      }
    }

    // Vite / React / Vue / Svelte / SvelteKit
    if (hasDep(pkg, 'vite') || hasDep(pkg, '@vitejs/plugin-react') || hasDep(pkg, '@sveltejs/vite-plugin-svelte')) {
      return {
        framework: 'vite',
        label: 'Vite',
        port: 80,
        healthPath: '/',
        dockerfile: VITE_DOCKERFILE,
        hasDockerfile: false,
      }
    }

    // Node API servers
    if (
      hasDep(pkg, 'express') ||
      hasDep(pkg, 'fastify') ||
      hasDep(pkg, '@nestjs/core') ||
      hasDep(pkg, 'hono') ||
      hasDep(pkg, 'koa')
    ) {
      return {
        framework: 'node',
        label: 'Node.js API',
        port: 3000,
        healthPath: null,
        dockerfile: NODE_DOCKERFILE,
        hasDockerfile: false,
      }
    }
  }

  // ── Python ──
  const hasRequirements = await exists(join(cwd, 'requirements.txt'))
  const hasPyproject = await exists(join(cwd, 'pyproject.toml'))
  if (hasRequirements || hasPyproject) {
    // Try to guess the ASGI/WSGI framework
    const reqText =
      (await readText(join(cwd, 'requirements.txt'))) ??
      (await readText(join(cwd, 'pyproject.toml'))) ??
      ''
    const isFastapi = /fastapi/i.test(reqText)
    const isFlask = /flask/i.test(reqText)
    const isDjango = /django/i.test(reqText)

    const entry = isDjango
      ? `django`
      : isFastapi
        ? `uvicorn main:app --host 0.0.0.0 --port 8000`.split(' ')[0]!
        : isFlask
          ? `flask`
          : 'app'

    // For FastAPI, override CMD to use uvicorn properly
    const pythonDF = isFastapi
      ? PYTHON_DOCKERFILE(entry, hasPyproject && !hasRequirements).replace(
          `CMD ["python", "-m", "${entry}"]`,
          `CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]`
        )
      : isDjango
        ? PYTHON_DOCKERFILE(entry, hasPyproject && !hasRequirements).replace(
            `CMD ["python", "-m", "${entry}"]`,
            `CMD ["python", "manage.py", "runserver", "0.0.0.0:8000"]`
          )
        : PYTHON_DOCKERFILE(entry, hasPyproject && !hasRequirements)

    return {
      framework: 'python',
      label: isFastapi ? 'Python (FastAPI)' : isDjango ? 'Python (Django)' : isFlask ? 'Python (Flask)' : 'Python',
      port: 8000,
      healthPath: null,
      dockerfile: pythonDF,
      hasDockerfile: false,
    }
  }

  // ── Go ──
  const goMod = await readText(join(cwd, 'go.mod'))
  if (goMod) {
    const moduleMatch = goMod.match(/^module\s+(.+)$/m)
    const moduleName = moduleMatch?.[1] ?? basename(cwd)
    return {
      framework: 'go',
      label: 'Go',
      port: 8080,
      healthPath: null,
      dockerfile: GO_DOCKERFILE(moduleName),
      hasDockerfile: false,
    }
  }

  // ── Rust ──
  if (await exists(join(cwd, 'Cargo.toml'))) {
    return {
      framework: 'rust',
      label: 'Rust',
      port: 8080,
      healthPath: null,
      dockerfile: RUST_DOCKERFILE,
      hasDockerfile: false,
    }
  }

  // ── Static / unknown ──
  // If there's an index.html, it's probably a static site
  if (await exists(join(cwd, 'index.html'))) {
    return {
      framework: 'static',
      label: 'Static site',
      port: 80,
      healthPath: '/',
      dockerfile: null,
      hasDockerfile: false,
    }
  }

  return {
    framework: 'unknown',
    label: 'unknown project',
    port: 3000,
    healthPath: null,
    dockerfile: null,
    hasDockerfile: false,
  }
}

// ── Manifest template ───────────────────────────────────────────────────

export function manifestTemplate(
  name: string,
  d: Detection,
): string {
  const build = d.hasDockerfile || d.dockerfile ? 'build: .' : `image: nginx:1.27`
  const portLine = d.port !== 80 ? `\n    container_port: ${d.port}` : ''
  return `fleet: homelab

services:
  ${name}:
    ${build}
    placement: flexible
    resources: { ram: 512Mi, cpu: 0.5 }
    health: { path: ${d.healthPath} }${portLine}
    # domain: ${name}.yourdomain.dev
`
}
