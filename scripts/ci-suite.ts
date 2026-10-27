type Selection = 'all' | string[]
type Plan = { unit: Selection; integration: Selection; e2e: Selection; e2eRepeat: string[] }

const [suite, shard = '1/1'] = process.argv.slice(2)
const plan = JSON.parse(process.env.PLAN ?? '{}') as Plan
const repositoryRoot = new URL('../', import.meta.url).pathname
const integrationPreload = './apps/server/src/testing/integration-setup.ts'
const fromRoot = (files: string[]) => files.map((file) => `./${file}`)

const commandOf = (suite: string | undefined) => {
  if (suite === 'unit') return plan.unit === 'all' ? ['bun', 'run', 'test'] : ['bun', 'test', ...fromRoot(plan.unit)]
  if (suite === 'integration')
    return plan.integration === 'all'
      ? ['bun', 'run', 'test:integration']
      : ['bun', 'test', '--preload', integrationPreload, ...fromRoot(plan.integration)]
  if (suite === 'e2e')
    return [
      'bun',
      'run',
      'test:e2e',
      '--',
      `--shard=${shard}`,
      '--pass-with-no-tests',
      ...(plan.e2e === 'all' ? [] : plan.e2e),
    ]
  if (suite === 'e2e-repeat')
    return ['bun', 'run', 'test:e2e', '--', '--repeat-each=3', '--retries=0', ...plan.e2eRepeat]
  throw new Error(`Unknown suite ${suite}: expected unit, integration, e2e or e2e-repeat`)
}

const command = commandOf(suite)
console.log(`▶ ${command.join(' ')}`)
const { exitCode } = Bun.spawnSync(command, { cwd: repositoryRoot, stdout: 'inherit', stderr: 'inherit' })
process.exit(exitCode)
