export const ROLES = ['viewer', 'deployer', 'admin', 'owner'] as const
export type Role = (typeof ROLES)[number]

/** Roles are a strict ladder; each one can do everything below it. */
const RANK: Record<Role, number> = { viewer: 0, deployer: 1, admin: 2, owner: 3 }

export function atLeast(role: Role, required: Role): boolean {
  return RANK[role] >= RANK[required]
}

/**
 * The permission table, written out rather than inferred, so that reviewing
 * "who can do what" is reading one list instead of tracing call sites.
 * Enforced at the API layer for every mutating endpoint (tech doc §10) —
 * the dashboard hiding a button is not access control.
 */
export const PERMISSIONS = {
  'fleet.read': 'viewer',
  'node.read': 'viewer',
  'service.read': 'viewer',
  'logs.read': 'viewer',
  'events.read': 'viewer',

  'service.deploy': 'deployer',
  'service.rollback': 'deployer',
  'service.reschedule': 'deployer',
  'secret.write': 'deployer',
  // Listing secrets returns names and timestamps, never values — but which
  // credentials a fleet holds is itself worth not handing to a viewer.
  'secret.read': 'deployer',

  'node.pair': 'admin',
  'node.cordon': 'admin',
  'node.drain': 'admin',
  'service.create': 'admin',
  'service.update': 'admin',
  'alert.write': 'admin',
  'audit.read': 'admin',

  'node.remove': 'owner',
  'member.manage': 'owner',
  'billing.manage': 'owner',
  'fleet.delete': 'owner',
} as const satisfies Record<string, Role>

export type Permission = keyof typeof PERMISSIONS

export function can(role: Role, permission: Permission): boolean {
  return atLeast(role, PERMISSIONS[permission])
}
