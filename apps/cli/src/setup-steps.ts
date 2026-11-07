import type { CloudflareCall } from './cloudflare.ts'
import { createAccessOidcApp, routeAdminMail } from './cloudflare-access.ts'
import { type AzRunner, isAzSignedIn, registerEntraApp, runAz } from './entra.ts'
import type { Environment } from './environment.ts'
import type { askerOf } from './flags.ts'
import { registerOktaApp } from './okta.ts'
import { resendApi, setUpResend } from './resend.ts'

export type Asker = ReturnType<typeof askerOf> & { isUnattended: boolean }
type SetupContext = { asker: Asker; hostname: string; origin: string; cloudflare?: CloudflareCall }

const providers = ['cloudflare-access', 'microsoft', 'okta', 'google', 'other', 'skip'] as const
const mailChoices = ['skip', 'smtp', 'resend', 'keep'] as const
export const removal = '-'

const cloudflareOf = ({ cloudflare }: SetupContext, what: string) => {
  if (!cloudflare) throw new Error(`${what} needs the Cloudflare API token: pass --cloudflare-token`)
  return cloudflare
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
      'Your own email address, which Cloudflare sends sign-in PINs and admin@ mail to',
    )
    const access = await createAccessOidcApp(cloudflare, { hostname, origin, ownerEmail, name: `Spyria ${hostname}` })
    const mail = await routeAdminMail(cloudflare, { hostname, ownerEmail })
    return [
      ...formLines('Other OIDC', {
        Issuer: access.issuer,
        'Client id': access.clientId,
        'Client secret': access.clientSecret,
      }),
      `${mail.adminAddress} now forwards to ${ownerEmail}${mail.awaitsConfirmation ? `: open the confirmation Cloudflare sent to ${ownerEmail} first` : ''}.`,
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
    const apiToken = asker.require('okta-token', 'Okta API token of an admin (used now, never stored)')
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
    hasMail ? 'keep' : 'skip',
  )
  if (choice === 'skip') return undefined
  if (choice === 'keep') return { url: existing.SPYRIA_SMTP_URL ?? '', from: existing.SPYRIA_MAIL_FROM ?? '' }
  if (choice === 'resend') {
    const apiKey = asker.require(
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
    url: asker.require('smtp-url', 'SMTP URL, for example smtps://user:pass@smtp.example.com:465'),
    from: asker.require(
      'mail-from',
      'Sender, for example Spyria <spyria@example.com>',
      existing.SPYRIA_MAIL_FROM ?? '',
    ),
  }
}
