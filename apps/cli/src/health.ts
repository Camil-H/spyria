type ServiceState = { Service: string; State: string; Health?: string }
type Problem = string

const expectedServices = ['postgres', 'server', 'zero-cache', 'gateway']

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
