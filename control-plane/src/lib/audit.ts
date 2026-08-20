import { auditLog } from '../db/schema.js'
import type { Db } from '../db/client.js'

export type AuditEntry = {
  orgId: string
  actorUserId?: string | null
  actorKind?: 'user' | 'agent' | 'system'
  action: string
  targetType: string
  targetId?: string | null
  metadata?: Record<string, unknown>
}

/**
 * FR-15. Takes a transaction handle rather than the pool on purpose: the
 * audit row must commit or roll back with the action it describes. An audit
 * log that can disagree with reality is not usable for security review, which
 * is the only reason it exists.
 */
export async function recordAudit(
  tx: Db | Parameters<Parameters<Db['transaction']>[0]>[0],
  entry: AuditEntry
): Promise<void> {
  await tx.insert(auditLog).values({
    orgId: entry.orgId,
    actorUserId: entry.actorUserId ?? null,
    actorKind: entry.actorKind ?? 'user',
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    metadata: entry.metadata ?? null,
  })
}
