# Control plane. Multi-stage so the runtime image carries no toolchain.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# argon2 is a native module; it needs a toolchain to build, but only here.
RUN apk add --no-cache python3 make g++ \
 && npm ci --omit=dev \
 && apk del python3 make g++

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN apk add --no-cache python3 make g++ && npm ci
COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:24-alpine AS runtime
WORKDIR /app
# git for webhook checkouts; docker CLI so buildx can be driven through a
# mounted socket rather than running a daemon inside this container.
RUN apk add --no-cache git docker-cli docker-cli-buildx tini

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY src/db/migrations ./dist/src/db/migrations

ENV NODE_ENV=production
EXPOSE 8080 8081

# Do not run as root: this process is reachable from the internet via ingress.
RUN addgroup -S fleet && adduser -S fleet -G fleet \
 && mkdir -p /var/lib/fleet-os/builds && chown -R fleet:fleet /var/lib/fleet-os
USER fleet

# tini reaps the git and docker child processes builds spawn.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/src/index.js"]
