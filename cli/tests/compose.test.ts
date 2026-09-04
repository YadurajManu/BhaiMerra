/**
 * docker-compose → fleet.yaml.
 *
 * The assertion that carries the most weight is the last one: every manifest
 * produced here is fed back through the control plane's own parser. A
 * converter that emits confident, well-formatted YAML the product then rejects
 * is worse than no converter, and only the real parser can say.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parse as parseYaml } from 'yaml'

import { composeToFleet } from '../src/compose.js'

const svc = (out: string, name: string) => parseYaml(out).services[name]
const db = (out: string, name: string) => parseYaml(out).databases?.[name]

describe('composeToFleet', () => {
  test('carries image, ports and dependencies across', () => {
    const { manifest } = composeToFleet(`
services:
  web:
    image: nginx:1.27-alpine
    ports: ["8080:80"]
    depends_on: [api]
  api:
    build: ./api
    ports: ["3000"]
`)
    assert.equal(svc(manifest, 'web').image, 'nginx:1.27-alpine')
    assert.equal(svc(manifest, 'web').port, 8080)
    assert.equal(svc(manifest, 'web').container_port, 80)
    // `uses` names databases only, so a dependency on another service has no
    // place to go and must not be invented one.
    assert.equal(svc(manifest, 'web').uses, undefined)
    assert.equal(svc(manifest, 'api').build, './api')
    // A single-number mapping is the same port on both sides, so naming it
    // twice would be noise.
    assert.equal(svc(manifest, 'api').container_port, undefined)
  })

  test('reads the port pair from the end, past a bind address', () => {
    const { manifest } = composeToFleet(`
services:
  web: { image: nginx, ports: ["127.0.0.1:8080:80/tcp"] }
`)
    assert.equal(svc(manifest, 'web').port, 8080)
    assert.equal(svc(manifest, 'web').container_port, 80)
  })

  test('a database image becomes a managed database, not a container', () => {
    const { manifest, notes } = composeToFleet(
      `
services:
  app: { image: app:1 }
  db:
    image: postgres:16
    environment:
      POSTGRES_DB: shop
      POSTGRES_USER: shop
      POSTGRES_PASSWORD: hunter2
`,
      { node: 'kakashi' }
    )
    const d = db(manifest, 'db')
    assert.equal(d.engine, 'postgres@16')
    assert.equal(d.node, 'kakashi')
    assert.equal(d.database, 'shop')
    assert.equal(d.user, 'shop')
    // The whole point: it is not a service any more.
    assert.equal(parseYaml(manifest).services?.db, undefined)
    // And the password from the compose file is not carried into a manifest
    // people commit.
    assert.ok(!manifest.includes('hunter2'))
    assert.ok(notes.some((n) => /managed postgres database/.test(n)))
  })

  test('recognises the other engines, including forks', () => {
    for (const [image, engine] of [
      ['redis:7-alpine', 'redis'],
      ['valkey/valkey:8', 'redis'],
      ['mariadb:11', 'mariadb'],
      ['mongo:7', 'mongo'],
      ['timescale/timescaledb:latest-pg16', 'postgres'],
      // Found in a real project: pgvector is what anything doing embeddings
      // runs, and it was becoming a plain container.
      ['ankane/pgvector:latest', 'postgres'],
      ['pgvector/pgvector:pg16', 'postgres'],
      ['bitnami/postgresql:16', 'postgres'],
    ] as const) {
      const { manifest } = composeToFleet(
        `services:\n  app: { image: app:1 }\n  store: { image: ${image} }`,
        { node: 'n1' }
      )
      assert.equal(db(manifest, 'store').engine.split('@')[0], engine, image)
    }
  })

  test('asks for the node rather than inventing one', () => {
    const { manifest, questions } = composeToFleet(
      'services:\n  app: { image: app:1 }\n  db: { image: postgres:16 }'
    )
    assert.match(manifest, /node: CHANGE_ME/)
    assert.equal(questions.length, 1)
    assert.match(questions[0]!, /must name the node/)
  })

  test('credentials become secrets, not env', () => {
    const { manifest } = composeToFleet(`
services:
  api:
    image: api:1
    environment:
      NODE_ENV: production
      DATABASE_PASSWORD: hunter2
      STRIPE_API_KEY: sk_live_x
      SESSION_TOKEN: abc
`)
    const s = svc(manifest, 'api')
    assert.deepEqual(s.env, { NODE_ENV: 'production' })
    assert.deepEqual(new Set(s.secrets), new Set(['DATABASE_PASSWORD', 'STRIPE_API_KEY', 'SESSION_TOKEN']))
    assert.ok(!manifest.includes('hunter2'), 'a password must not survive into the manifest')
    assert.ok(!manifest.includes('sk_live_x'))
  })

  test('a value compose left to interpolation becomes a secret', () => {
    // ${VAR} is not a value: it is a promise that the shell will supply one.
    // Copying the literal text through would set the variable to "${VAR}".
    const { manifest } = composeToFleet(`
services:
  api:
    image: api:1
    environment:
      - REGION=eu-west-1
      - UPSTREAM=\${UPSTREAM_URL}
      - EMPTY=
`)
    const s = svc(manifest, 'api')
    assert.deepEqual(s.env, { REGION: 'eu-west-1' })
    assert.deepEqual(new Set(s.secrets), new Set(['UPSTREAM', 'EMPTY']))
    assert.ok(!manifest.includes('${'), 'no unresolved interpolation may reach the manifest')
  })

  test('named volumes survive, bind mounts do not', () => {
    const { manifest, notes } = composeToFleet(`
services:
  app:
    image: app:1
    volumes:
      - ./src:/app/src
      - uploads:/var/lib/uploads
`)
    assert.deepEqual(svc(manifest, 'app').volume, { name: 'uploads', path: '/var/lib/uploads' })
    assert.ok(!manifest.includes('./src'))
    assert.ok(notes.some((n) => /dropped \.\/src:\/app\/src/.test(n)), 'a dropped bind mount must be reported even when another volume was kept')
  })

  test('memory limits convert, and a missing one is stated rather than hidden', () => {
    const { manifest, notes } = composeToFleet(`
services:
  big:
    image: a:1
    deploy: { resources: { limits: { memory: 2g, cpus: "1.5" } } }
  small:
    image: b:1
`)
    assert.deepEqual(svc(manifest, 'big').resources, { ram: '2048Mi', cpu: 1.5 })
    assert.deepEqual(svc(manifest, 'small').resources, { ram: '512Mi', cpu: 0.5 })
    assert.ok(notes.some((n) => /small: compose set no memory limit/.test(n)))
  })

  test('a health path is lifted out of a healthcheck when there is one', () => {
    const { manifest } = composeToFleet(`
services:
  api:
    image: api:1
    healthcheck: { test: ["CMD", "curl", "-f", "http://localhost:3000/healthz"] }
  other:
    image: b:1
    healthcheck: { test: ["CMD-SHELL", "pg_isready"] }
`)
    assert.deepEqual(svc(manifest, 'api').health, { path: '/healthz' })
    assert.deepEqual(svc(manifest, 'other').health, { path: '/' })
  })

  test('refuses a file that is only databases, and says why', () => {
    // The product requires something to deploy. Emitting an empty `services:`
    // key instead would fail later, in the parser, with a message about
    // records that says nothing about what the reader actually did.
    assert.throws(
      () => composeToFleet('services:\n  db: { image: postgres:16 }\n  cache: { image: redis:7 }'),
      /every service in that file is a database \(db, cache\).*something to deploy/s
    )
  })

  test('refuses input that is not a compose file', () => {
    assert.throws(() => composeToFleet('name: something\nversion: 1'), /no services found/)
    assert.throws(() => composeToFleet('services:\n  - ['), /not valid YAML/)
  })

  test('build and image together keeps image, and says so', () => {
    const { manifest, notes } = composeToFleet(`
services:
  app: { image: app:1, build: . }
`)
    assert.equal(svc(manifest, 'app').image, 'app:1')
    assert.equal(svc(manifest, 'app').build, undefined)
    assert.ok(notes.some((n) => /kept image/.test(n)))
  })
})

describe('the output is a manifest the product accepts', () => {
  // A realistic file: a built app, a third-party image, two engines, secrets,
  // a volume, replicas and dependencies.
  const REAL = `
services:
  web:
    build: ./web
    ports: ["80:3000"]
    depends_on: [api]
    deploy: { replicas: 2, resources: { limits: { memory: 512m, cpus: "0.5" } } }
    environment:
      NODE_ENV: production
      SESSION_SECRET: dev-only
    healthcheck: { test: ["CMD", "wget", "-qO-", "http://localhost:3000/healthz"] }
  api:
    image: ghcr.io/acme/api:2.1
    ports: ["8080"]
    depends_on: { db: { condition: service_healthy }, cache: { condition: service_started } }
    environment:
      - DATABASE_URL=\${DATABASE_URL}
      - LOG_LEVEL=info
    volumes: [ "artifacts:/var/lib/artifacts" ]
  db:
    image: postgres:16
    environment: { POSTGRES_DB: acme, POSTGRES_USER: acme, POSTGRES_PASSWORD: p4ssw0rd-x9 }
  cache:
    image: redis:7-alpine
volumes: { artifacts: {}, pgdata: {} }
`

  test('parses, and says what it decided', () => {
    const { manifest, notes, questions } = composeToFleet(REAL, { fleet: 'homelab', node: 'kakashi' })
    const doc = parseYaml(manifest)
    assert.equal(doc.fleet, 'homelab')
    assert.deepEqual(Object.keys(doc.services), ['web', 'api'])
    assert.deepEqual(Object.keys(doc.databases), ['db', 'cache'])
    assert.equal(doc.services.web.replicas, 2)
    assert.deepEqual(doc.services.api.uses, ['db', 'cache'])  // both are databases
    assert.equal(doc.databases.cache.engine, 'redis@7')
    assert.equal(questions.length, 0, 'a node was supplied, so nothing should be outstanding')
    assert.ok(notes.length > 0)
    assert.ok(!manifest.includes('p4ssw0rd-x9'), 'the postgres password must not appear')
  })
})

describe('a connection string that names a converted database', () => {
  test('is rewritten to the URL Fleet will inject, and is not made a secret', () => {
    // Left alone this goes wrong two ways, both of which deploy cleanly and
    // then fail to connect: copied verbatim the app dials a host that no
    // longer exists, and swept into `secrets` (the key ends in _URI) the user
    // is asked to supply a value Fleet already knows.
    const { manifest } = composeToFleet(
      `services:
  mongo:
    image: mongo:7
  api:
    build: ./api
    environment:
      MONGODB_URI: mongodb://mongo:27017/notevault
`,
      { node: 'homelab-1' }
    )

    assert.match(manifest, /MONGODB_URI: "\$\{db:db\.url\}"/)
    assert.ok(
      !/secrets: \[[^\]]*MONGODB_URI/.test(manifest),
      'it is a value Fleet knows, not one the user has to invent'
    )
  })

  test('a connection string to something else is left alone', () => {
    // An external database is not Fleet's to rewrite, and pretending it is
    // would silently repoint an app at an empty local instance.
    const { manifest } = composeToFleet(
      `services:
  api:
    build: ./api
    environment:
      MONGODB_URI: mongodb+srv://user:pw@cluster0.example.mongodb.net/app
`,
      { node: 'homelab-1' }
    )
    assert.ok(!/secret:DB_PASSWORD/.test(manifest), 'no rewrite')
  })

  test('the password is a reference, never a value', () => {
    // A manifest is a file people commit, and the password is generated by the
    // control plane and unknown here anyway.
    const { manifest } = composeToFleet(
      `services:
  db-pg:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: hunter2
  api:
    build: ./api
    environment:
      DATABASE_URL: postgres://someone:hunter2@db-pg:5432/app
`,
      { node: 'homelab-1' }
    )
    assert.ok(!manifest.includes('hunter2'), 'the compose password must not survive into the manifest')
    // A reference the control plane fills in, rather than a URL the CLI built
    // from its own copy of the engine table.
    assert.match(manifest, /\$\{db:[a-z0-9-]+\.url\}/)
  })
})
