export type AzRunner = (azArguments: string[]) => { exitCode: number; output: string }

export const runAz: AzRunner = (azArguments) => {
  const result = Bun.spawnSync(['az', ...azArguments], { stdout: 'pipe', stderr: 'pipe' })
  return {
    exitCode: result.exitCode,
    output: (result.exitCode === 0 ? result.stdout : result.stderr).toString().trim(),
  }
}

export const isAzSignedIn = (az: AzRunner = runAz) =>
  Bun.which('az') !== null && az(['account', 'show', '--query', 'tenantId', '-o', 'tsv']).exitCode === 0

export const registerEntraApp = (
  { origin, audience }: { origin: string; audience: 'tenant' | 'any-account' },
  az: AzRunner = runAz,
) => {
  const run = (azArguments: string[]) => {
    const { exitCode, output } = az(azArguments)
    if (exitCode !== 0) throw new Error(`az ${azArguments.slice(0, 3).join(' ')} failed: ${output}`)
    return output
  }
  const tenantId = run(['account', 'show', '--query', 'tenantId', '-o', 'tsv'])
  const clientId = run([
    ...['ad', 'app', 'create', '--display-name', `Spyria ${new URL(origin).hostname}`],
    ...(audience === 'tenant'
      ? ['--sign-in-audience', 'AzureADMyOrg']
      : ['--sign-in-audience', 'AzureADandPersonalMicrosoftAccount', '--requested-access-token-version', '2']),
    ...['--web-redirect-uris', `${origin}/auth/callback`, '--query', 'appId', '-o', 'tsv'],
  ])
  run(['ad', 'sp', 'create', '--id', clientId, '--query', 'id', '-o', 'tsv'])
  const clientSecret = run([
    ...['ad', 'app', 'credential', 'reset', '--id', clientId, '--display-name', 'Spyria'],
    ...['--years', '2', '--query', 'password', '-o', 'tsv'],
  ])
  return { tenantId, clientId, clientSecret }
}
