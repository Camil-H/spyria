import { type Environment, secretNames } from './environment.ts'

type Publisher = { URL?: string; PublishedPort?: number }
type ServiceState = { Service: string; State: string; Health?: string; Publishers?: Publisher[] | null }
type Problem = string

const expectedServices = ['postgres', 'server', 'zero-cache', 'gateway']
const loopbackAddresses = ['127.0.0.1', '::1']
const everyAddress = ['', '0.0.0.0', '::']
const minimumSecretLength = 32
const isDevelopmentDefault = (value: string) => value === 'spyria' || value.startsWith('spyria-dev-')

export const serviceStatesOf = (psOutput: string): ServiceState[] => {
  const text = psOutput.trim()
  if (text === '') return []
  if (text.startsWith('[')) return JSON.parse(text)
  return text.split('\n').map((line) => JSON.parse(line))
}

export const serviceProblemsOf = (states: readonly ServiceState[], profiles: readonly string[]): Problem[] => {
  const expected = [
    ...expectedServices,
    ...(profiles.includes('host') ? ['host'] : []),
    ...(profiles.includes('cloudflare') ? ['cloudflared'] : []),
  ]
  return expected.flatMap((service) => {
    const state = states.find((candidate) => candidate.Service === service)
    if (!state) return [`${service} is not running`]
    if (state.State !== 'running') return [`${service} is ${state.State}`]
    if (state.Health && state.Health !== 'healthy') return [`${service} is ${state.Health}`]
    return []
  })
}

export const publishedPortProblemsOf = (states: readonly ServiceState[]): Problem[] => [
  ...new Set(
    states.flatMap(({ Service, Publishers }) =>
      (Publishers ?? [])
        .filter(({ URL = '', PublishedPort = 0 }) => PublishedPort > 0 && !loopbackAddresses.includes(URL))
        .map(
          ({ URL, PublishedPort }) =>
            `${Service} publishes port ${PublishedPort} on ${everyAddress.includes(URL ?? '') ? 'every address' : URL}, reachable from other machines: publish it on 127.0.0.1 only`,
        ),
    ),
  ),
]

export const environmentFileModeProblemOf = (mode: number): Problem | undefined =>
  (mode & 0o077) !== 0
    ? `.env is open to other users of this machine (mode ${(mode & 0o777).toString(8)}): run chmod 600 on it`
    : undefined

export const credentialProblemsOf = (environment: Environment): Problem[] => [
  ...secretNames.flatMap((name) => {
    const value = environment[name] ?? ''
    if (value === '') return [`${name} is missing from .env: run spyria setup again, which generates it`]
    if (value.length < minimumSecretLength || isDevelopmentDefault(value))
      return [`${name} is a default or short value: replace it as the troubleshooting guide shows`]
    return []
  }),
  ...(isDevelopmentDefault(environment.SPYRIA_GATEWAY_ADMIN_USER ?? '')
    ? ['SPYRIA_GATEWAY_ADMIN_USER is a development default: give it another name']
    : []),
]

export const productionProblemsIn = (serverLogs: string): Problem[] => {
  const lines = serverLogs.split('\n').map((line) => line.replace(/^\S+\s+\|\s?/, ''))
  const start = lines.findLastIndex((line) => line.startsWith('Spyria cannot start in production:'))
  if (start === -1) return []
  const problems: Problem[] = []
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('- ')) break
    problems.push(line.slice(2))
  }
  return problems
}

export const diskProblemOf = (availableKibibytes: number, minimumGibibytes = 5): Problem | undefined =>
  availableKibibytes < minimumGibibytes * 1024 * 1024
    ? `Only ${(availableKibibytes / 1024 / 1024).toFixed(1)} GiB of disk is free (at least ${minimumGibibytes} GiB is advised)`
    : undefined

export const backupsToRemoveOf = (files: readonly string[], keep: number) => {
  const byDatabase = Map.groupBy(
    files.filter((file) => /^(spyria|bifrost)-\d{8}T\d{6}Z\.dump$/.test(file)),
    (file) => file.split('-')[0],
  )
  return [...byDatabase.values()].flatMap((dumps) => dumps.toSorted().reverse().slice(keep))
}

export const backupNameOf = (database: string, now: Date) =>
  `${database}-${now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')}.dump`
