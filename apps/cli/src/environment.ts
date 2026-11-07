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

export const parseEnvironment = (text: string): Environment =>
  Object.fromEntries(
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#') && line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  )

export const serializeEnvironment = (environment: Environment) =>
  Object.entries(environment)
    .filter(([, value]) => value !== '')
    .map(([name, value]) => {
      if (/[\n\r]/.test(value)) throw new Error(`${name} cannot span lines`)
      return `${name}=${value}\n`
    })
    .join('')

export const withSecrets = (existing: Environment): Environment => ({
  ...Object.fromEntries(secretNames.map((name) => [name, existing[name] || newSecret()])),
  SPYRIA_GATEWAY_ADMIN_USER: existing.SPYRIA_GATEWAY_ADMIN_USER || `admin-${randomBytes(4).toString('hex')}`,
  SPYRIA_INSTALL_HOST_TOKEN: existing.SPYRIA_INSTALL_HOST_TOKEN || newInstallHostToken(),
})

export type SetupAnswers = {
  deployment: string
  version: string
  images: string
  origin: string
  joinBy: 'domain' | 'invited-address'
  tunnelToken?: string
  runsHost: boolean
  dockerGroup: string
  smtp?: { url: string; from: string }
  instanceApps: {
    google?: { clientId: string; clientSecret: string }
    microsoft?: { clientId: string; clientSecret: string }
  }
  localPort: number
}

export const environmentOf = (answers: SetupAnswers, existing: Environment = {}): Environment => {
  if (!isDeploymentName(answers.deployment))
    throw new Error('The deployment name takes lowercase letters, digits and dashes')
  if (!answers.origin.startsWith('https://')) throw new Error('The address of Spyria must start with https://')
  const secrets = withSecrets(existing)
  const profiles = [...(answers.runsHost ? ['host'] : []), ...(answers.tunnelToken ? ['cloudflare'] : [])]
  return {
    ...existing,
    SPYRIA_DEPLOYMENT: answers.deployment,
    SPYRIA_VERSION: answers.version,
    SPYRIA_IMAGES: answers.images,
    SPYRIA_APP_ORIGIN: answers.origin,
    SPYRIA_JOIN_BY: answers.joinBy,
    SPYRIA_LOCAL_PORT: String(answers.localPort),
    ...secrets,
    COMPOSE_PROFILES: profiles.join(','),
    SPYRIA_TRUSTED_PROXY: answers.tunnelToken ? 'cloudflare' : '',
    CLOUDFLARE_TUNNEL_TOKEN: answers.tunnelToken ?? '',
    SPYRIA_HOST_CLAIM_URL: answers.runsHost ? `http://server:3000/h/${secrets.SPYRIA_INSTALL_HOST_TOKEN}` : '',
    SPYRIA_DOCKER_GROUP: answers.runsHost ? answers.dockerGroup : '',
    SPYRIA_SMTP_URL: answers.smtp?.url ?? '',
    SPYRIA_MAIL_FROM: answers.smtp?.from ?? '',
    SPYRIA_GOOGLE_CLIENT_ID: answers.instanceApps.google?.clientId ?? existing.SPYRIA_GOOGLE_CLIENT_ID ?? '',
    SPYRIA_GOOGLE_CLIENT_SECRET:
      answers.instanceApps.google?.clientSecret ?? existing.SPYRIA_GOOGLE_CLIENT_SECRET ?? '',
    SPYRIA_MICROSOFT_CLIENT_ID: answers.instanceApps.microsoft?.clientId ?? existing.SPYRIA_MICROSOFT_CLIENT_ID ?? '',
    SPYRIA_MICROSOFT_CLIENT_SECRET:
      answers.instanceApps.microsoft?.clientSecret ?? existing.SPYRIA_MICROSOFT_CLIENT_SECRET ?? '',
  }
}

export const setupLinkOf = (environment: Environment) =>
  `${environment.SPYRIA_APP_ORIGIN}/?${new URLSearchParams({ setup: environment.SPYRIA_SETUP_TOKEN ?? '' })}`
