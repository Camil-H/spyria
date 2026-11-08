import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import bifrostConfig from '../../../deploy/bifrost.json'
import composeFile from '../../../deploy/compose.prod.yml' with { type: 'text' }
import { cloudflareApi, cloudflareClientOf, createTunnel } from './cloudflare.ts'
import {
  installFolderOf,
  readEnvironment,
  releaseFilesOf,
  sendsTestMessage,
  startStack,
  writeEnvironment,
  writeReleaseFiles,
} from './commands.ts'
import { environmentFileOf, operatorCommandOf, readCompose } from './compose.ts'
import { type AzRunner, isAzSignedIn, registerEntraApp, runAz } from './entra.ts'
import { environmentOf, isDeploymentName, type SetupAnswers } from './environment.ts'
import { askerOf, type Flags, type ProcessEnvironment, secretVariables } from './flags.ts'
import { cliVersion, defaultImages, latestVersion } from './release.ts'
import { type Asker, firstWorkspaceProviderOf, mailOf, removal } from './setup-steps.ts'

const googleClientIdPattern = /^[\w-]+\.apps\.googleusercontent\.com$/
const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const hostnamePattern = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/

const hostnameOf = (origin = '') => URL.parse(origin)?.hostname ?? ''
const dockerGroupOf = () => {
  if (process.platform === 'darwin') return '0'
  const stat = Bun.spawnSync(['stat', '-c', '%g', '/var/run/docker.sock'], { stdout: 'pipe', stderr: 'ignore' })
  return stat.exitCode === 0 ? stat.stdout.toString().trim() : '0'
}

const runsHostOf = (flags: Flags, existingProfiles: string | undefined) =>
  flags.switches.has('host') ||
  (!flags.switches.has('no-host') && (existingProfiles === undefined || existingProfiles.split(',').includes('host')))

const instanceAppOf = (
  asker: Asker,
  provider: 'google' | 'microsoft',
  origin: string,
  existing: { clientId?: string; clientSecret?: string },
  az: AzRunner,
) => {
  const guide =
    provider === 'google'
      ? `Google sign-in through an app of this Spyria (optional). In Google Cloud > APIs & Services > Credentials (https://console.cloud.google.com/apis/credentials), create an OAuth client of type Web application with the redirect URI ${origin}/auth/callback, and an External consent screen asking for openid, email and profile.`
      : `Microsoft sign-in through an app of this Spyria (optional). In Microsoft Entra > App registrations (https://entra.microsoft.com), register an app for accounts in any organizational directory with the web redirect URI ${origin}/auth/callback, then create a client secret. Or answer create to register it now with az, signed in as an admin of your directory.`
  const flagPrefix = `${provider}-client`
  if (!asker.isUnattended && existing.clientId === undefined) console.log(guide)
  const clientId = asker.ask(
    `${flagPrefix}-id`,
    `${provider === 'google' ? 'Google' : 'Microsoft'} client id (empty to skip${existing.clientId ? ', - to remove' : ''})`,
    existing.clientId ?? '',
  )
  if (clientId === '' || clientId === removal) return undefined
  if (provider === 'microsoft' && clientId === 'create') {
    if (!isAzSignedIn(az)) throw new Error('Sign in with az login first, or register the app by hand')
    const { clientId: createdClientId, clientSecret } = registerEntraApp({ origin, audience: 'organizations' }, az)
    return { clientId: createdClientId, clientSecret }
  }
  const pattern = provider === 'google' ? googleClientIdPattern : guidPattern
  if (!pattern.test(clientId))
    throw new Error(
      `${clientId} is not a ${provider === 'google' ? 'Google OAuth' : 'Microsoft application'} client id`,
    )
  const savedSecret = clientId === existing.clientId ? (existing.clientSecret ?? '') : ''
  const clientSecret = asker.secret(
    `${flagPrefix}-secret`,
    savedSecret ? 'Client secret (empty keeps the saved one)' : 'Client secret',
    savedSecret,
  )
  if (clientSecret === '') throw new Error(`${secretVariables[`${flagPrefix}-secret`]} is required`)
  return { clientId, clientSecret }
}

export const setup = async (
  flags: Flags,
  {
    cloudflareApiUrl = cloudflareApi,
    resendApiUrl,
    az = runAz,
    processEnvironment = process.env,
  }: {
    cloudflareApiUrl?: string
    resendApiUrl?: string
    az?: AzRunner
    processEnvironment?: ProcessEnvironment
  } = {},
) => {
  const isUnattended = flags.switches.has('unattended')
  const asker: Asker = { ...askerOf(flags, isUnattended, processEnvironment), isUnattended }
  const folder = installFolderOf({
    ...flags,
    values: { ...flags.values, folder: asker.ask('folder', 'Install folder', installFolderOf(flags)) },
  })
  mkdirSync(join(folder, 'backups'), { recursive: true })
  const existing = existsSync(environmentFileOf(folder)) ? readEnvironment(folder) : {}
  if (Object.keys(existing).length > 0) console.log(`Setting up ${folder} again: its secrets are kept.`)
  const deployment = asker.ask('name', 'Deployment name', existing.SPYRIA_DEPLOYMENT ?? 'spyria')
  if (!isDeploymentName(deployment)) throw new Error('The deployment name takes lowercase letters, digits and dashes')

  const hostname = asker
    .require(
      'hostname',
      'Hostname of Spyria, on a domain of your Cloudflare account',
      hostnameOf(existing.SPYRIA_APP_ORIGIN),
    )
    .toLowerCase()
  if (!hostnamePattern.test(hostname)) throw new Error(`${hostname} is not a hostname`)
  const origin = `https://${hostname}`
  const keepsTunnel =
    existing.CLOUDFLARE_TUNNEL_TOKEN !== undefined && hostnameOf(existing.SPYRIA_APP_ORIGIN) === hostname
  const apiToken = asker.secret(
    'cloudflare-token',
    `Cloudflare API token with Account > Cloudflare Tunnel > Edit, Zone > DNS > Edit and Zone > Zone > Read, used now and never stored${keepsTunnel ? ' (empty to keep the current tunnel)' : ''}`,
  )
  const tunnelToken = apiToken
    ? (await createTunnel({ apiToken, hostname, tunnelName: `${deployment}-${hostname}`, api: cloudflareApiUrl })).token
    : keepsTunnel
      ? existing.CLOUDFLARE_TUNNEL_TOKEN
      : undefined
  if (!tunnelToken) throw new Error('A Cloudflare API token is required to create the tunnel')

  const joinBy = asker.choose(
    'join-by',
    'Who can join: people at your email domain, or only the addresses you invite',
    ['domain', 'invited-address'],
    existing.SPYRIA_JOIN_BY === 'invited-address' ? 'invited-address' : 'domain',
  )
  const google = instanceAppOf(
    asker,
    'google',
    origin,
    {
      clientId: existing.SPYRIA_GOOGLE_CLIENT_ID,
      clientSecret: existing.SPYRIA_GOOGLE_CLIENT_SECRET,
    },
    az,
  )
  const microsoft =
    joinBy === 'domain'
      ? instanceAppOf(
          asker,
          'microsoft',
          origin,
          {
            clientId: existing.SPYRIA_MICROSOFT_CLIENT_ID,
            clientSecret: existing.SPYRIA_MICROSOFT_CLIENT_SECRET,
          },
          az,
        )
      : undefined
  const cloudflare = apiToken ? cloudflareClientOf(apiToken, cloudflareApiUrl) : undefined
  const context = { asker, hostname, origin, cloudflare }
  const providerLines = await firstWorkspaceProviderOf(context, { joinBy, az })
  if (providerLines.length > 0) console.log(['', ...providerLines, ''].join('\n'))
  const smtp = await mailOf(context, { existing, resendApiUrl })
  const version =
    flags.values.version ?? existing.SPYRIA_VERSION ?? (cliVersion === 'dev' ? await latestVersion() : cliVersion)
  const answers: SetupAnswers = {
    deployment,
    version,
    images: flags.values.images ?? existing.SPYRIA_IMAGES ?? defaultImages,
    origin,
    joinBy,
    tunnelToken,
    runsHost: runsHostOf(flags, existing.COMPOSE_PROFILES),
    dockerGroup: dockerGroupOf(),
    smtp,
    instanceApps: { google, microsoft },
    localPort: Number(flags.values.port ?? existing.SPYRIA_LOCAL_PORT ?? 3300),
  }
  const environment = environmentOf(answers, existing)
  writeReleaseFiles(
    folder,
    version === cliVersion || cliVersion === 'dev'
      ? { compose: composeFile, bifrost: `${JSON.stringify(bifrostConfig, null, 2)}\n` }
      : await releaseFilesOf(version),
  )
  writeEnvironment(folder, environment)
  console.log(`Wrote ${folder}: compose.yml, bifrost.json and .env (readable by you only).`)
  if (flags.switches.has('no-start')) return
  await startStack(folder, environment)
  const testAddress = smtp && asker.ask('mail-test', 'Address to send a test message to (empty to skip)', '')
  if (testAddress && !sendsTestMessage(folder, testAddress))
    console.log('The test message was not sent: check the SMTP URL and the sender, then run spyria setup again.')
  const setupLink = readCompose(folder, operatorCommandOf(['setup-link']))
  console.log(
    [
      '',
      `Spyria ${version} runs at ${origin}.`,
      setupLink.exitCode === 0
        ? `Create the first workspace from this setup link, which works once: ${setupLink.output.trim()}`
        : '',
      answers.runsHost ? 'This machine runs a runtime host: it joins the first workspace when you create it.' : '',
      'Then, in Workspace settings, Connect GitHub to work on repositories.',
    ]
      .filter(Boolean)
      .join('\n'),
  )
}
