# Control plane.
#
# Debian slim rather than Alpine on purpose: argon2 is a native module, and on
# musl there is no prebuilt binary, so every image build compiles it from
# source. That is minutes per build and one more way a self-hoster's install
# can fail. glibc gets the prebuild and the build is seconds.
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:24-slim AS runtime
WORKDIR /app

# git for webhook checkouts; the docker CLI so buildx can be driven through a
# mounted socket rather than running a daemon in here; tini to reap the git
# and docker children that builds spawn.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini curl \
 && ARCH=$(uname -m) \
 && if [ "$ARCH" = "aarch64" ]; then BUILDX_ARCH="arm64"; else BUILDX_ARCH="amd64"; fi \
 && curl -fsSL https://download.docker.com/linux/static/stable/${ARCH}/docker-27.3.1.tgz \
    | tar -xz -C /usr/local/bin --strip-components=1 docker/docker \
 && mkdir -p /usr/libexec/docker/cli-plugins \
 && curl -fsSL "https://github.com/docker/buildx/releases/download/v0.19.3/buildx-v0.19.3.linux-${BUILDX_ARCH}" \
    -o /usr/libexec/docker/cli-plugins/docker-buildx \
 && chmod +x /usr/libexec/docker/cli-plugins/docker-buildx \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY src/db/migrations ./dist/src/db/migrations

ENV NODE_ENV=production
ENV MIGRATIONS_DIR=/app/dist/src/db/migrations
EXPOSE 8080 8081

# Not root: ingress makes this process reachable from the internet.
RUN groupadd -r fleet && useradd -m -r -g fleet -G root fleet \
 && mkdir -p /var/lib/fleet-os/builds /home/fleet/.docker && chown -R fleet:fleet /var/lib/fleet-os /home/fleet
USER root
RUN chmod 666 /var/run/docker.sock 2>/dev/null || true
USER fleet

HEALTHCHECK --interval=10s --timeout=3s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/src/index.js"]
