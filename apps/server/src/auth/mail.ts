import { createTransport } from 'nodemailer'

export type Mail = { to: string; subject: string; text: string }
export type Mailer = { send: (mail: Mail) => Promise<void> }

export const createSmtpMailer = ({ smtpUrl, from }: { smtpUrl: string; from: string }): Mailer => {
  const transport = createTransport(smtpUrl)
  return {
    send: async (mail) => {
      await transport.sendMail({ from, ...mail })
    },
  }
}
