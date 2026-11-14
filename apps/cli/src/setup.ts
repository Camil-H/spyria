import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import bifrostConfig from '../../../deploy/bifrost.json'
import composeFile from '../../../deploy/compose.prod.yml' with { type: 'text' }
import { cloudflareApi, cloudflareClientOf, createTunnel } from './cloudflare.ts'
import {
  assertNoOtherProjectIn,
  assertPostgresRuns,
  backup,
  forgetEarlierHostPairing,
  installFolderOf,
  readEnvironment,
  releaseFilesOf,
  startStack,
  writeEnvironment,
  writeReleaseFiles,
} from './commands.ts'
import { environmentFileOf, operatorCommandOf, readCompose } from './compose.ts'
import { type AzRunner, isAzSignedIn, registerEntraApp, runAz } from './entra.ts'
import { type Environment, environmentOf, isDeploymentName, pairingCodeOf, type SetupAnswers } from './environment.ts'
import { askerOf, type Flags, type ProcessEnvironment, secretVariables } from './flags.ts'
import { cliVersion, defaultImages, latestVersion } from './release.ts'
import { type Asker, firstWorkspaceProviderOf, removal } from './setup-steps.ts'

const googleClientIdPattern = /^[\w-]+\.apps\.googleusercontent\.com$/
const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const hostnamePattern = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/

const localPortOf = (given: string) => {
  const port = Number(given)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port takes a port number from 1 to 65535')
  return port
}

const hostnameOf = (origin = '') => URL.parse(origin)?.hostname ?? ''
const dockerGroupOf = () => {
  if (process.platform === 'darwin') return '0'
  const stat = Bun.spawnSync(['stat', '-c', '%g', '/var/run/docker.sock'], { stdout: 'pipe', stderr: 'ignore' })
  return stat.exitCode === 0 ? stat.stdout.toString().trim() : '0'
}

const runsHostOf = (flags: Flags, existingProfiles: string | undefined) =>
  flags.switches.has('host') ||
  (!flags.switches.has('no-host') && (existingProfiles === undefined || existingProfiles.split(',').includes('host')))

const workspaceExistsInRunningStack = (folder: string) => {
  if (Bun.which('docker', { PATH: process.env.PATH ?? '' }) === null) return undefined
  const answer = readCompose(folder, operatorCommandOf(['has-workspace']))
  const output = answer.output.trim()
  if (answer.exitCode !== 0 || (output !== 'yes' && output !== 'no')) return undefined
  return output === 'yes'
}

const addRuntimeHostGuide =
  "this machine's runtime host pairs with the command an admin gets from Workspace settings > Runtimes > Add runtime host"

const pairingCodeFor = (
  asker: Asker,
  { folder, origin, existing, runsHost }: { folder: string; origin: string; existing: Environment; runsHost: boolean },
  workspaceExistsIn: (folder: string) => boolean | undefined,
) => {
  if (!runsHost) return undefined
  const variable = secretVariables['host-claim-url']
  if (asker.given('host-claim-url')) return pairingCodeOf(asker.requireSecret('host-claim-url', ''), origin)
  const turnsHostOn = existing.COMPOSE_PROFILES !== undefined && !existing.COMPOSE_PROFILES.split(',').includes('host')
  if (!turnsHostOn) return undefined
  const hasWorkspace = workspaceExistsIn(folder)
  if (hasWorkspace === false) return undefined
  if (hasWorkspace === undefined) {
    if (asker.isUnattended)
      throw new Error(
        `Setup cannot tell whether a workspace exists, since Spyria does not answer: start it with spyria compose up -d and run setup again, or set ${variable} to the command of Add runtime host`,
      )
    console.log(
      `Spyria does not answer, so setup cannot tell whether a workspace exists. Once one exists, ${addRuntimeHostGuide}.`,
    )
    const command = asker.secret('host-claim-url', 'Command of Add runtime host (empty if no workspace exists yet)')
    return command ? pairingCodeOf(command, origin) : undefined
  }
  console.log(`A workspace exists, so ${addRuntimeHostGuide}.`)
  return pairingCodeOf(asker.requireSecret('host-claim-url', 'Command of Add runtime host'), origin)
}

type AccountApp = { clientId: string; clientSecret: string }
type SavedAccountApp = { clientId?: string; clientSecret?: string }
type AccountProvider = 'google' | 'microsoft'

const instanceClientIdOf = (asker: Asker, provider: AccountProvider, origin: string, existing: SavedAccountApp) => {
  const guide =
    provider === 'google'
      ? `Sign-in with any Google account, Gmail included, through an app of this Spyria (optional). In Google Cloud > APIs & Services > Credentials (https://console.cloud.google.com/apis/credentials), create an OAuth client of type Web application with the redirect URI ${origin}/auth/callback, and an External consent screen asking for openid, email and profile.`
      : `Sign-in with Microsoft work, school or personal accounts through an app of this Spyria (optional). In Microsoft Entra > App registrations (https://entra.microsoft.com), register an app for Accounts in any organizational directory and personal Microsoft accounts, with the web redirect URI ${origin}/auth/callback, then create a client secret. Or answer create to register it now with az.`
  if (!asker.isUnattended && existing.clientId === undefined) console.log(guide)
  return asker.ask(
    `${provider}-client-id`,
    `${provider === 'google' ? 'Google' : 'Microsoft'} client id (empty to skip${existing.clientId ? ', - to remove' : ''})`,
    existing.clientId ?? '',
  )
}

const instanceAppOf = (
  asker: Asker,
  provider: AccountProvider,
  clientId: string,
  existing: SavedAccountApp,
): AccountApp | undefined => {
  if (clientId === '' || clientId === removal) return undefined
  const flagPrefix = `${provider}-client`
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

const registeredMicrosoftAppOf = (origin: string, existing: SavedAccountApp, az: AzRunner): AccountApp => {
  const entra = registerEntraApp({ origin, audience: 'any-account', savedClientId: existing.clientId }, az)
  const clientSecret = entra.clientSecret ?? (entra.clientId === existing.clientId ? existing.clientSecret : undefined)
  if (!clientSecret)
    throw new Error(
      `Microsoft Entra already holds the app ${entra.name} (client id ${entra.clientId}), whose secret this install does not have: give its client id and a new client secret of it instead of create`,
    )
  return { clientId: entra.clientId, clientSecret }
}

const savedAppOf = ({ clientId, clientSecret }: SavedAccountApp) =>
  clientId && clientSecret ? { clientId, clientSecret } : undefined

const oidcAccountAppOf = (asker: Asker, origin: string, existing: Environment) => {
  const savedIssuer = existing.SPYRIA_OIDC_ISSUER
  if (!asker.isUnattended && savedIssuer === undefined)
    console.log(
      `Sign-in with accounts of another OIDC provider through an app of this Spyria (optional). Register a client there with the redirect URI ${origin}/auth/callback and the scopes openid, email and profile.`,
    )
  const issuer = asker.ask(
    'oidc-issuer',
    `OIDC issuer URL, for example https://login.example.com (empty to skip${savedIssuer ? ', - to remove' : ''})`,
    savedIssuer ?? '',
  )
  if (issuer === '' || issuer === removal) return undefined
  if (URL.parse(issuer)?.protocol !== 'https:') throw new Error(`${issuer} is not an https address`)
  const clientId = asker.require('oidc-client-id', 'OIDC client id', existing.SPYRIA_OIDC_CLIENT_ID ?? '')
  const isSavedApp = issuer === savedIssuer && clientId === existing.SPYRIA_OIDC_CLIENT_ID
  const savedSecret = isSavedApp ? (existing.SPYRIA_OIDC_CLIENT_SECRET ?? '') : ''
  const clientSecret = asker.secret(
    'oidc-client-secret',
    savedSecret ? 'Client secret (empty keeps the saved one)' : 'Client secret',
    savedSecret,
  )
  if (clientSecret === '') throw new Error(`${secretVariables['oidc-client-secret']} is required`)
  return { issuer, clientId, clientSecret }
}

export const setup = async (
  flags: Flags,
  {
    cloudflareApiUrl = cloudflareApi,
    az = runAz,
    processEnvironment = process.env,
    workspaceExistsIn = workspaceExistsInRunningStack,
  }: {
    cloudflareApiUrl?: string
    az?: AzRunner
    processEnvironment?: ProcessEnvironment
    workspaceExistsIn?: (folder: string) => boolean | undefined
  } = {},
) => {
  const isUnattended = flags.switches.has('unattended')
  const asker: Asker = { ...askerOf(flags, isUnattended, processEnvironment), isUnattended }
  const folder = installFolderOf({
    ...flags,
    values: { ...flags.values, folder: asker.ask('folder', 'Install folder', installFolderOf(flags)) },
  })
  assertNoOtherProjectIn(folder)
  mkdirSync(join(folder, 'backups'), { recursive: true })
  const existing = existsSync(environmentFileOf(folder)) ? readEnvironment(folder) : {}
  if (Object.keys(existing).length > 0) console.log(`Setting up ${folder} again: its secrets are kept.`)
  const deployment = asker.ask('name', 'Deployment name', existing.SPYRIA_DEPLOYMENT ?? 'spyria')
  if (!isDeploymentName(deployment)) throw new Error('The deployment name takes lowercase letters, digits and dashes')
  const localPort = localPortOf(flags.values.port ?? existing.SPYRIA_LOCAL_PORT ?? '3300')

  const hostname = asker
    .require(
      'hostname',
      'Hostname of Spyria, on a domain of your Cloudflare account',
      hostnameOf(existing.SPYRIA_APP_ORIGIN),
    )
    .toLowerCase()
  if (!hostnamePattern.test(hostname)) throw new Error(`${hostname} is not a hostname`)
  const origin = `https://${hostname}`
  const runsHost = runsHostOf(flags, existing.COMPOSE_PROFILES)
  const pairingCode = pairingCodeFor(asker, { folder, origin, existing, runsHost }, workspaceExistsIn)
  const keepsTunnel =
    existing.CLOUDFLARE_TUNNEL_TOKEN !== undefined && hostnameOf(existing.SPYRIA_APP_ORIGIN) === hostname
  const apiToken = asker.secret(
    'cloudflare-token',
    `Cloudflare API token with Account > Cloudflare Tunnel > Edit, Zone > DNS > Edit and Zone > Zone > Read, used now and never stored${keepsTunnel ? ' (empty to keep the current tunnel)' : ''}`,
  )
  if (!apiToken && !keepsTunnel) throw new Error('A Cloudflare API token is required to create the tunnel')

  const savedGoogleApp = {
    clientId: existing.SPYRIA_GOOGLE_CLIENT_ID,
    clientSecret: existing.SPYRIA_GOOGLE_CLIENT_SECRET,
  }
  const google = instanceAppOf(
    asker,
    'google',
    instanceClientIdOf(asker, 'google', origin, savedGoogleApp),
    savedGoogleApp,
  )
  const savedMicrosoftApp = {
    clientId: existing.SPYRIA_MICROSOFT_CLIENT_ID,
    clientSecret: existing.SPYRIA_MICROSOFT_CLIENT_SECRET,
  }
  const microsoftClientId = instanceClientIdOf(asker, 'microsoft', origin, savedMicrosoftApp)
  const createsMicrosoftApp = microsoftClientId === 'create'
  if (createsMicrosoftApp && !isAzSignedIn(az))
    throw new Error('Sign in with az login first, or register the app by hand')
  const microsoft = createsMicrosoftApp
    ? savedAppOf(savedMicrosoftApp)
    : instanceAppOf(asker, 'microsoft', microsoftClientId, savedMicrosoftApp)
  const oidc = oidcAccountAppOf(asker, origin, existing)
  const cloudflare = apiToken ? cloudflareClientOf(apiToken, cloudflareApiUrl) : undefined
  const setUpFirstWorkspaceProvider = firstWorkspaceProviderOf({ asker, hostname, origin, cloudflare }, { az })
  const version =
    flags.values.version ?? existing.SPYRIA_VERSION ?? (cliVersion === 'dev' ? await latestVersion() : cliVersion)
  let answers: SetupAnswers = {
    deployment,
    version,
    images: flags.values.images ?? existing.SPYRIA_IMAGES ?? defaultImages,
    origin,
    tunnelToken: keepsTunnel ? existing.CLOUDFLARE_TUNNEL_TOKEN : undefined,
    runsHost,
    pairingCode,
    dockerGroup: dockerGroupOf(),
    instanceApps: { google, microsoft, oidc },
    localPort,
  }
  let environment = environmentOf(answers, existing)
  const releaseFiles =
    version === cliVersion || cliVersion === 'dev'
      ? { compose: composeFile, bifrost: `${JSON.stringify(bifrostConfig, null, 2)}\n` }
      : await releaseFilesOf(version)
  if (existing.SPYRIA_VERSION !== undefined && existing.SPYRIA_VERSION !== version) {
    console.log(`Backing up before changing from ${existing.SPYRIA_VERSION} to ${version}`)
    assertPostgresRuns(folder, 'run setup again')
    await backup(folder, flags)
  }
  if (
    runsHost &&
    existing.COMPOSE_PROFILES !== undefined &&
    environment.SPYRIA_HOST_CLAIM_URL !== existing.SPYRIA_HOST_CLAIM_URL
  )
    forgetEarlierHostPairing(folder, environment)

  const keepInEnvironment = (created: Partial<SetupAnswers>) => {
    answers = { ...answers, ...created }
    environment = environmentOf(answers, environment)
    writeEnvironment(folder, environment)
  }
  if (apiToken)
    keepInEnvironment({
      tunnelToken: (
        await createTunnel({ apiToken, hostname, tunnelName: `${deployment}-${hostname}`, api: cloudflareApiUrl })
      ).token,
    })
  if (createsMicrosoftApp)
    keepInEnvironment({
      instanceApps: { ...answers.instanceApps, microsoft: registeredMicrosoftAppOf(origin, savedMicrosoftApp, az) },
    })
  await setUpFirstWorkspaceProvider()
  writeReleaseFiles(folder, releaseFiles)
  writeEnvironment(folder, environment)
  console.log(`Wrote ${folder}: compose.yml, bifrost.json and .env (readable by you only).`)
  if (flags.switches.has('no-start')) return
  await startStack(folder, environment)
  const setupLink = readCompose(folder, operatorCommandOf(['setup-link']))
  console.log(
    [
      '',
      `Spyria ${version} runs at ${origin}.`,
      setupLink.exitCode === 0
        ? `Create the first workspace from this setup link, which works once: ${setupLink.output.trim()}`
        : '',
      answers.pairingCode
        ? 'This machine runs a runtime host: it joins the workspace whose admin made its command.'
        : answers.runsHost && setupLink.exitCode === 0
          ? 'This machine runs a runtime host: it joins the first workspace when you create it.'
          : '',
      'Then, in Workspace settings, open GitHub to connect it and work on repositories.',
      Object.values(answers.instanceApps).some(Boolean)
        ? 'Anyone who signs in with an app of this Spyria can then create a workspace; a workspace can require its own sign-in provider in Single sign-on.'
        : 'People join the first workspace by invite, signing in with its own provider.',
    ]
      .filter(Boolean)
      .join('\n'),
  )
}
