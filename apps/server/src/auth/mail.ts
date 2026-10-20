import { withRetries } from '@spyria/kernel'
import { createTransport } from 'nodemailer'

export type Mail = { to: string; subject: string; text: string }
export type Mailer = { send: (mail: Mail) => Promise<void> }

const connectionTimeoutMilliseconds = 10_000
const sendTimeoutMilliseconds = 30_000

const failedBeforeConnecting = (error: unknown) => {
  const { syscall, code } = (error ?? {}) as { syscall?: string; code?: string }
  return syscall === 'connect' || code === 'EDNS'
}

export const createSmtpMailer = ({ smtpUrl, from }: { smtpUrl: string; from: string }): Mailer => {
  const transport = createTransport({
    url: smtpUrl,
    connectionTimeout: connectionTimeoutMilliseconds,
    greetingTimeout: connectionTimeoutMilliseconds,
    socketTimeout: sendTimeoutMilliseconds,
  })
  return {
    send: async (mail) => {
      await withRetries(() => transport.sendMail({ from, ...mail }), {
        timeoutMilliseconds: sendTimeoutMilliseconds,
        isRetried: (outcome) => 'error' in outcome && failedBeforeConnecting(outcome.error),
      })
    },
  }
}
