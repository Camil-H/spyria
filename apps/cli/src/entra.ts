export type AzRunner = (azArguments: string[]) => { exitCode: number; output: string }
type Audience = 'tenant' | 'organizations'

export const runAz: AzRunner = (azArguments) => {
  const result = Bun.spawnSync(['az', ...azArguments], { stdout: 'pipe', stderr: 'pipe' })
  return {
    exitCode: result.exitCode,
    output: (result.exitCode === 0 ? result.stdout : result.stderr).toString().trim(),
  }
}

export const isAzSignedIn = (az: AzRunner = runAz) =>
  Bun.which('az', { PATH: process.env.PATH ?? '' }) !== null &&
  az(['account', 'show', '--query', 'tenantId', '-o', 'tsv']).exitCode === 0

const entraAppNameOf = (origin: string, audience: Audience) =>
  `Spyria ${new URL(origin).hostname}${audience === 'tenant' ? ' workspace' : ''}`

export const registerEntraApp = (
  { origin, audience, savedClientId }: { origin: string; audience: Audience; savedClientId?: string },
  az: AzRunner = runAz,
) => {
  const run = (azArguments: string[]) => {
    const { exitCode, output } = az(azArguments)
    if (exitCode !== 0) throw new Error(`az ${azArguments.slice(0, 3).join(' ')} failed: ${output}`)
    return output
  }
  const name = entraAppNameOf(origin, audience)
  const tenantId = run(['account', 'show', '--query', 'tenantId', '-o', 'tsv'])
  const registeredClientIds = run([
    ...['ad', 'app', 'list', '--filter', `displayName eq '${name}'`],
    ...['--query', '[].appId', '-o', 'tsv'],
  ])
    .split('\n')
    .filter(Boolean)
  const [registeredClientId] = registeredClientIds.filter((id) => id === savedClientId).concat(registeredClientIds)
  if (registeredClientId) return { name, tenantId, clientId: registeredClientId, clientSecret: undefined }
  const clientId = run([
    ...['ad', 'app', 'create', '--display-name', name],
    ...['--sign-in-audience', audience === 'tenant' ? 'AzureADMyOrg' : 'AzureADMultipleOrgs'],
    ...['--web-redirect-uris', `${origin}/auth/callback`, '--query', 'appId', '-o', 'tsv'],
  ])
  run(['ad', 'sp', 'create', '--id', clientId, '--query', 'id', '-o', 'tsv'])
  const clientSecret = run([
    ...['ad', 'app', 'credential', 'reset', '--id', clientId, '--display-name', 'Spyria'],
    ...['--years', '2', '--query', 'password', '-o', 'tsv'],
  ])
  return { name, tenantId, clientId, clientSecret }
}
