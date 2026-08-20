import '@fastify/jwt'
import type { AppContext } from '../api/context.js'
import type { Role } from '../auth/rbac.js'

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext
  }
  interface FastifyRequest {
    /** Set by requireUser. */
    userId?: string
    /** Set by requireOrgRole, so handlers do not re-query membership. */
    orgId?: string
    orgRole?: Role
    /** Set by requireAgent. */
    agentNodeId?: string
    agentFleetId?: string
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; typ: 'access' | 'refresh'; jti?: string }
    user: { sub: string; typ: 'access' | 'refresh'; jti?: string }
  }
}
