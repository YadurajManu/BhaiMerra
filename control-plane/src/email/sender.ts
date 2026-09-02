import { ResendEmailSender } from './resend.js'
import type { EmailSender } from '../alerting/dispatch.js'
import type { Config } from '../config.js'

export type { EmailSender }

type Logger = { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void }

/**
 * The sender used when no provider is configured.
 *
 * It records what would have been sent and resolves. Most people running Fleet
 * OS on their own hardware will never set up a mail provider, and a control
 * plane that refuses to boot — or that throws every time a node goes down —
 * because nobody configured email would be a worse product for them. The same
 * reasoning as builds: a missing buildx makes deploys fail with an explanation,
 * not the whole process.
 *
 * It logs rather than staying silent so "why did I get no email" is answerable
 * from the logs instead of by reading this file.
 */
export class LoggingEmailSender implements EmailSender {
  constructor(private readonly log?: Logger) {}

  async send(to: string, subject: string, _body: string): Promise<void> {
    this.log?.warn(
      { to, subject },
      'email not sent: no RESEND_API_KEY configured on this control plane'
    )
  }
}

/**
 * Pick a sender from configuration. Both values are required together — an API
 * key with no from-address cannot send, and a from-address with no key is a
 * setting that quietly does nothing, which is worse than either.
 */
export function createEmailSender(config: Config, log?: Logger): EmailSender {
  if (config.RESEND_API_KEY && config.MAIL_FROM) {
    return new ResendEmailSender(config.RESEND_API_KEY, config.MAIL_FROM)
  }
  if (config.RESEND_API_KEY || config.MAIL_FROM) {
    log?.warn(
      { hasKey: Boolean(config.RESEND_API_KEY), hasFrom: Boolean(config.MAIL_FROM) },
      'email is half-configured and disabled: RESEND_API_KEY and MAIL_FROM must both be set'
    )
  }
  return new LoggingEmailSender(log)
}
