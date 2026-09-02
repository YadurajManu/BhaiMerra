import { runDueDeletions } from './auth/account-deletion.js'
import { pruneExpiredTokens } from './auth/email-tokens.js'
import { deletionCompleteEmail } from './email/templates.js'
import type { AppContext } from './api/context.js'

/**
 * Slow housekeeping, on its own clock.
 *
 * The heartbeat sweeper ticks every few seconds because a dead node has to be
 * noticed quickly. Nothing here is urgent — a seven-day grace period does not
 * care about seconds — and running it at heartbeat frequency would be thousands
 * of pointless queries a day.
 *
 * This lives in its own module rather than inline in index.ts so the path that
 * actually deletes accounts in production is the same path a test can call.
 * An entry point runs on import, which makes anything defined inside it
 * effectively untestable, and "the deletion logic is covered but the thing that
 * invokes it is not" is exactly the gap worth closing for an irreversible
 * operation.
 */

export const JANITOR_INTERVAL_MS = 60 * 60_000

type Logger = {
  info: (o: unknown, m: string) => void
  warn: (o: unknown, m: string) => void
  error: (o: unknown, m: string) => void
}

export type JanitorResult = {
  accountsDeleted: number
  closureEmailsSent: number
  tokensPruned: number
}

export async function runJanitor(ctx: AppContext, log?: Logger): Promise<JanitorResult> {
  const result: JanitorResult = { accountsDeleted: 0, closureEmailsSent: 0, tokensPruned: 0 }

  const deleted = await runDueDeletions(ctx, log)
  result.accountsDeleted = deleted.length

  for (const d of deleted) {
    // Sent after the row is gone, deliberately: the address is already in hand,
    // and a "your account is closed" email arriving while the account still
    // exists would be a lie. A failure here must not undo the deletion or stop
    // the next person's.
    const { subject, body } = deletionCompleteEmail(d.orgsDeleted)
    try {
      await ctx.email.send(d.email, subject, body)
      result.closureEmailsSent++
    } catch (err) {
      log?.warn({ err }, 'account closed email failed to send')
    }
  }

  result.tokensPruned = await pruneExpiredTokens(ctx)
  if (result.tokensPruned) log?.info({ pruned: result.tokensPruned }, 'expired auth tokens pruned')

  return result
}

export function startJanitor(ctx: AppContext, log?: Logger): { stop: () => void } {
  const timer = setInterval(() => {
    void runJanitor(ctx, log).catch((err) => log?.error({ err }, 'janitor tick failed'))
  }, JANITOR_INTERVAL_MS)

  // Housekeeping must never be the reason the process cannot exit.
  timer.unref()
  return { stop: () => clearInterval(timer) }
}
