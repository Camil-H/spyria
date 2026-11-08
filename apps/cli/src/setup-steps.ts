import type { CloudflareCall } from './cloudflare.ts'
import { createAccessOidcApp, routeAdminMail } from './cloudflare-access.ts'
import { type AzRunner, isAzSignedIn, registerEntraApp, runAz } from './entra.ts'
import type { Environment } from './environment.ts'
import { type askerOf, secretVariables } from './flags.ts'
import { registerOktaApp } from './okta.ts'
import { resendApi, setUpResend } from './resend.ts'

export type Asker = ReturnType<typeof askerOf> & { isUnattended: boolean }
type SetupContext = { asker: Asker; hostname: string; origin: string; cloudflare?: CloudflareCall }

const providers = ['cloudflare-access', 'microsoft', 'okta', 'google', 'other', 'skip'] as const
const smtpUrlOf = (asker: Asker, saved: string) => {
  const question = 'SMTP URL, for example smtps://user:pass@smtp.example.com:465'
  const url = asker.secret('smtp-url', saved ? `${question} (empty keeps the saved one)` : question, saved)
  if (url === '') throw new Error(`${secretVariables['smtp-url']} is required`)
  return url
}

const mailChoices = ['skip', 'smtp', 'resend', 'keep'] as const
export const removal = '-'

const cloudflareOf = ({ cloudflare }: SetupContext, what: string) => {
  if (!cloudflare)
    throw new Error(`${what} needs the Cloudflare API token: set SPYRIA_SETUP_CLOUDFLARE_TOKEN or answer its question`)
  return cloudflare
}

const adminMailLines = {
  routed: (adminAddress: string, ownerEmail: string) => `${adminAddress} forwards to ${ownerEmail}.`,
  awaits_confirmation: (adminAddress: string, ownerEmail: string) =>
    `${adminAddress} forwards to ${ownerEmail} once you open the confirmation Cloudflare just sent there.`,
  routed_elsewhere: (adminAddress: string) =>
    `${adminAddress} already forwards elsewhere in Email Routing: its PIN arrives there.`,
  has_mailboxes: (adminAddress: string) =>
    `Your domain already receives mail, so ${adminAddress} must be a mailbox or alias you can read.`,
}

const formLines = (preset: string, fields: Record<string, string>) => [
  `In Create a workspace, choose ${preset} and enter:`,
  ...Object.entries(fields).map(([label, value]) => `  ${label}: ${value}`),
  'This is the only time Spyria shows the client secret.',
]

export const firstWorkspaceProviderOf = async (
  context: SetupContext,
  { joinBy, az = runAz }: { joinBy: 'domain' | 'invited-address'; az?: AzRunner },
): Promise<string[]> => {
  const { asker, origin, hostname } = context
  const provider = asker.choose(
    'provider',
    'Provider people sign in with in the first workspace',
    providers.filter((choice) => choice !== 'cloudflare-access' || joinBy === 'domain'),
    'skip',
  )
  if (provider === 'skip') return []
  if (provider === 'cloudflare-access') {
    const cloudflare = cloudflareOf(context, 'Cloudflare Access')
    const ownerEmail = asker.require(
      'owner-email',
      'Your own email address, where admin@ your domain forwards (sign-in PINs and the verification link)',
    )
    const access = await createAccessOidcApp(cloudflare, { hostname, origin, name: `Spyria ${hostname}` })
    const mail = await routeAdminMail(cloudflare, { hostname, ownerEmail })
    return [
      ...formLines('Other OIDC', {
        'Email domain': access.domain,
        Issuer: access.issuer,
        'Client id': access.clientId,
        'Client secret': access.clientSecret,
      }),
      `Then sign in as ${mail.adminAddress}: Cloudflare emails its one-time PIN to that address.`,
      adminMailLines[mail.outcome](mail.adminAddress, ownerEmail),
    ]
  }
  if (provider === 'microsoft') {
    if (!isAzSignedIn(az))
      return [
        `Register an app in Microsoft Entra > App registrations for accounts in this organizational directory only, with the web redirect URI ${origin}/auth/callback, and create a client secret (or sign in with az login and run spyria setup again).`,
        'In Create a workspace, choose Microsoft Entra and enter its tenant id, client id and secret.',
      ]
    const entra = registerEntraApp({ origin, audience: 'tenant' }, az)
    return formLines('Microsoft Entra', {
      'Tenant id': entra.tenantId,
      'Client id': entra.clientId,
      'Client secret': entra.clientSecret,
    })
  }
  if (provider === 'okta') {
    const orgUrl = asker.require('okta-url', 'Okta organization URL, for example https://acme.okta.com')
    const apiToken = asker.requireSecret('okta-token', 'Okta API token of an admin (used now, never stored)')
    const okta = await registerOktaApp({ orgUrl, apiToken, origin })
    return formLines('Other OIDC', {
      Issuer: okta.issuer,
      'Client id': okta.clientId,
      'Client secret': okta.clientSecret,
    })
  }
  if (provider === 'google')
    return [
      `In Google Cloud > APIs & Services > Credentials (https://console.cloud.google.com/apis/credentials), create an OAuth client of type Web application with the redirect URI ${origin}/auth/callback, and an External consent screen asking for openid, email and profile.`,
      'In Create a workspace, choose Google Workspace and enter its client id and secret.',
    ]
  return [
    `Register a client at your OIDC provider with the redirect URI ${origin}/auth/callback, then choose Other OIDC in Create a workspace.`,
  ]
}

export const mailOf = async (
  context: SetupContext,
  { existing, resendApiUrl = resendApi }: { existing: Environment; resendApiUrl?: string },
) => {
  const { asker, hostname } = context
  const hasMail = Boolean(existing.SPYRIA_SMTP_URL)
  const choice = asker.choose(
    'mail',
    'Mail for domain verification links: none, an SMTP URL, or Resend with its DNS records written in Cloudflare',
    mailChoices.filter((option) => option !== 'keep' || hasMail),
    asker.given('resend-key') ? 'resend' : asker.given('smtp-url') ? 'smtp' : hasMail ? 'keep' : 'skip',
  )
  if (choice === 'skip') return undefined
  if (choice === 'keep') return { url: existing.SPYRIA_SMTP_URL ?? '', from: existing.SPYRIA_MAIL_FROM ?? '' }
  if (choice === 'resend') {
    const apiKey = asker.requireSecret(
      'resend-key',
      'Resend API key with full access (used now; a sending-only key is stored)',
    )
    const resend = await setUpResend({
      apiKey,
      hostname,
      cloudflare: cloudflareOf(context, 'Resend'),
      api: resendApiUrl,
    })
    return { url: resend.smtpUrl, from: asker.ask('mail-from', 'Sender', resend.mailFrom) }
  }
  return {
    url: smtpUrlOf(asker, existing.SPYRIA_SMTP_URL ?? ''),
    from: asker.require(
      'mail-from',
      'Sender, for example Spyria <spyria@example.com>',
      existing.SPYRIA_MAIL_FROM ?? '',
    ),
  }
}
