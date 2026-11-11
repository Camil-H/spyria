import { randomBytes } from 'node:crypto'

export type Environment = Record<string, string>

const secretNames = [
  'SPYRIA_TOKEN_SECRET',
  'SPYRIA_SECRETS_KEY',
  'SPYRIA_SETUP_TOKEN',
  'SPYRIA_GATEWAY_ADMIN_PASSWORD',
  'SPYRIA_GATEWAY_ENCRYPTION_KEY',
  'SPYRIA_GATEWAY_SETUP_TOKEN',
  'SPYRIA_GATEWAY_DB_PASSWORD',
  'SPYRIA_POSTGRES_PASSWORD',
  'SPYRIA_ZERO_ADMIN_PASSWORD',
] as const
const claimCodeAlphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const installHostTokenLength = 16
const unbiasedByteLimit = 256 - (256 % claimCodeAlphabet.length)
const deploymentPattern = /^[a-z0-9][a-z0-9-]{0,40}$/

export const newSecret = () => randomBytes(32).toString('hex')

export const newInstallHostToken = () => {
  let token = ''
  while (token.length < installHostTokenLength)
    for (const byte of randomBytes(installHostTokenLength * 2))
      if (byte < unbiasedByteLimit && token.length < installHostTokenLength)
        token += claimCodeAlphabet[byte % claimCodeAlphabet.length]
  return token
}

export const isDeploymentName = (name: string) => deploymentPattern.test(name)

const unquoted = (value: string) => value.replace(/^'(.*)'$/s, '$1').replace(/^"(.*)"$/s, '$1')

export const parseEnvironment = (text: string): Environment =>
  Object.fromEntries(
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#') && line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), unquoted(line.slice(line.indexOf('=') + 1))]),
  )

const storable = (environment: Environment) => {
  for (const [name, value] of Object.entries(environment))
    if (/[\n\r']/.test(value)) throw new Error(`${name} cannot hold a quote or span lines`)
  return environment
}

export const serializeEnvironment = (environment: Environment) =>
  Object.entries(storable(environment))
    .filter(([, value]) => value !== '')
    .map(([name, value]) => `${name}='${value}'\n`)
    .join('')

export const withSecrets = (existing: Environment): Environment => ({
  ...Object.fromEntries(secretNames.map((name) => [name, existing[name] || newSecret()])),
  SPYRIA_GATEWAY_ADMIN_USER: existing.SPYRIA_GATEWAY_ADMIN_USER || `admin-${randomBytes(4).toString('hex')}`,
})

export type SetupAnswers = {
  deployment: string
  version: string
  images: string
  origin: string
  tunnelToken?: string
  runsHost: boolean
  dockerGroup: string
  instanceApps: {
    google?: { clientId: string; clientSecret: string }
    microsoft?: { clientId: string; clientSecret: string }
    oidc?: { issuer: string; clientId: string; clientSecret: string }
  }
  localPort: number
  pairingCode?: string
}

const pairingAddressPattern = new RegExp(`(https?://[^\\s/]+)/h/([${claimCodeAlphabet}]{8,})`, 'g')
const personalFlagPattern = /(^|\s)--personal(\s|$)/
const hostClaimUrlOf = (code: string) => `http://server:3000/h/${code}`

export const pairingCodeOf = (command: string, origin: string) => {
  const [, commandOrigin, code] = [...command.matchAll(pairingAddressPattern)].at(-1) ?? []
  if (!code)
    throw new Error('This is not the command of Add runtime host: it ends with an address holding /h/ and a code')
  if (personalFlagPattern.test(command))
    throw new Error("This command adds a member's own machine: take the one of Add runtime host")
  if (commandOrigin !== origin) throw new Error(`This command pairs with ${commandOrigin}, not with ${origin}`)
  return code
}

const hostPairingOf = (answers: SetupAnswers, existing: Environment) => {
  if (!answers.runsHost) return { SPYRIA_INSTALL_HOST_TOKEN: '', SPYRIA_HOST_CLAIM_URL: '' }
  if (answers.pairingCode)
    return { SPYRIA_INSTALL_HOST_TOKEN: '', SPYRIA_HOST_CLAIM_URL: hostClaimUrlOf(answers.pairingCode) }
  if (existing.SPYRIA_HOST_CLAIM_URL && !existing.SPYRIA_INSTALL_HOST_TOKEN)
    return { SPYRIA_INSTALL_HOST_TOKEN: '', SPYRIA_HOST_CLAIM_URL: existing.SPYRIA_HOST_CLAIM_URL }
  const installHostToken = existing.SPYRIA_INSTALL_HOST_TOKEN || newInstallHostToken()
  return { SPYRIA_INSTALL_HOST_TOKEN: installHostToken, SPYRIA_HOST_CLAIM_URL: hostClaimUrlOf(installHostToken) }
}

export const environmentOf = (answers: SetupAnswers, existing: Environment = {}): Environment => {
  if (!isDeploymentName(answers.deployment))
    throw new Error('The deployment name takes lowercase letters, digits and dashes')
  if (!answers.origin.startsWith('https://')) throw new Error('The address of Spyria must start with https://')
  const secrets = withSecrets(existing)
  const profiles = [...(answers.runsHost ? ['host'] : []), ...(answers.tunnelToken ? ['cloudflare'] : [])]
  return storable({
    ...existing,
    SPYRIA_DEPLOYMENT: answers.deployment,
    SPYRIA_VERSION: answers.version,
    SPYRIA_IMAGES: answers.images,
    SPYRIA_APP_ORIGIN: answers.origin,
    SPYRIA_LOCAL_PORT: String(answers.localPort),
    ...secrets,
    ...hostPairingOf(answers, existing),
    COMPOSE_PROFILES: profiles.join(','),
    SPYRIA_TRUSTED_PROXY: answers.tunnelToken ? 'cloudflare' : '',
    CLOUDFLARE_TUNNEL_TOKEN: answers.tunnelToken ?? '',
    SPYRIA_DOCKER_GROUP: answers.runsHost ? answers.dockerGroup : '',
    SPYRIA_GOOGLE_CLIENT_ID: answers.instanceApps.google?.clientId ?? '',
    SPYRIA_GOOGLE_CLIENT_SECRET: answers.instanceApps.google?.clientSecret ?? '',
    SPYRIA_MICROSOFT_CLIENT_ID: answers.instanceApps.microsoft?.clientId ?? '',
    SPYRIA_MICROSOFT_CLIENT_SECRET: answers.instanceApps.microsoft?.clientSecret ?? '',
    SPYRIA_OIDC_ISSUER: answers.instanceApps.oidc?.issuer ?? '',
    SPYRIA_OIDC_CLIENT_ID: answers.instanceApps.oidc?.clientId ?? '',
    SPYRIA_OIDC_CLIENT_SECRET: answers.instanceApps.oidc?.clientSecret ?? '',
  })
}
