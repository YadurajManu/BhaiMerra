import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import { ApiError } from './api/errors.js'
import { authRoutes } from './api/auth.routes.js'
import { agentRoutes } from './api/agent.routes.js'
import { fleetRoutes } from './api/fleets.routes.js'
import { webhookRoutes } from './api/webhooks.routes.js'
import { githubRoutes } from './api/github.routes.js'
import { installRoutes } from './api/install.routes.js'
import { serviceRoutes } from './api/services.routes.js'
import type { AppContext } from './api/context.js'

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: ctx.config.LOG_LEVEL,
      redact: {
        // Tokens must never reach a log file, including on an error path.
        paths: ['req.headers.authorization', 'body.password', 'body.refreshToken'],
        censor: '[redacted]',
      },
    },
    trustProxy: true,
    bodyLimit: 1_048_576,
  })

  app.decorate('ctx', ctx)
  await app.register(cors, { origin: true, credentials: true })
  await app.register(jwt, { secret: ctx.config.JWT_SECRET })

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply
        .code(err.statusCode)
        .send({ error: { code: err.code, message: err.message, detail: err.detail } })
    }
    const fastifyErr = err as { validation?: unknown; message?: string; statusCode?: number; code?: string }
    if (fastifyErr.validation) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_request', message: fastifyErr.message ?? 'Invalid request' } })
    }
    // Framework errors, such as an unsupported media type, are client errors.
    // Do not hide them behind a generic 500; callers need a useful correction.
    if (fastifyErr.statusCode && fastifyErr.statusCode >= 400 && fastifyErr.statusCode < 500) {
      return reply.code(fastifyErr.statusCode).send({
        error: {
          code: fastifyErr.code ?? 'invalid_request',
          message: fastifyErr.message ?? 'Invalid request',
        },
      })
    }
    req.log.error({ err }, 'unhandled error')
    return reply
      .code(500)
      .send({ error: { code: 'internal_error', message: 'Something went wrong' } })
  })

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({
      error: { code: 'no_route', message: `No route for ${req.method} ${req.url}` },
    })
  )

  await app.register(authRoutes)
  await app.register(agentRoutes)
  await app.register(fleetRoutes)
  await app.register(webhookRoutes)
  await app.register(githubRoutes)
  await app.register(installRoutes)
  await app.register(serviceRoutes)

  return app
}
