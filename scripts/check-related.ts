import { existsSync } from 'node:fs'

type Suite = { name: string; files: Set<string>; full: string[] }
type Cruised = { modules: { source: string; dependencies: { resolved: string }[] }[] }

const baseIndex = process.argv.indexOf('--base')
const base = baseIndex === -1 ? 'HEAD' : (process.argv[baseIndex + 1] ?? 'HEAD')
const repositoryRoot = new URL('../', import.meta.url).pathname
const startedAt = performance.now()

const output = (command: string[]) => {
  const result = Bun.spawnSync(command, { cwd: repositoryRoot, stderr: 'inherit' })
  if (result.exitCode !== 0) throw new Error(`${command.join(' ')} failed`)
  return result.stdout.toString()
}
const run = async (label: string, command: string[]) => {
  const started = performance.now()
  const child = Bun.spawn(command, { cwd: repositoryRoot, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { label, exitCode, seconds: (performance.now() - started) / 1000, stdout, log: stdout + stderr }
}
const runInherited = (label: string, command: string[]) => {
  console.log(`\n▶ ${label}: ${command.join(' ')}`)
  const started = performance.now()
  const { exitCode } = Bun.spawnSync(command, { cwd: repositoryRoot, stdout: 'inherit', stderr: 'inherit' })
  return { label, exitCode, seconds: (performance.now() - started) / 1000, log: '' }
}

const changedFiles = [
  ...new Set([
    ...output(['git', 'diff', '--name-only', base]).split('\n'),
    ...output(['git', 'ls-files', '--others', '--exclude-standard']).split('\n'),
  ]),
].filter(Boolean)

const fastChecks = Promise.all([
  run('lint', ['bun', 'run', 'lint']),
  run('typecheck', ['bun', 'run', 'typecheck']),
  run('boundaries', ['bun', 'run', 'check:boundaries']),
  run('dependency graph', [
    'bunx',
    'depcruise',
    'apps',
    'packages',
    '--config',
    '.dependency-cruiser.cjs',
    '--output-type',
    'json',
  ]),
])

const isUnitTest = (file: string) =>
  /^(packages|apps\/server|apps\/host|apps\/agent)\/.+\.test\.tsx?$/.test(file) &&
  !/\.(integration|docker)\.test\.ts$/.test(file)
const isIntegrationTest = (file: string) => file.endsWith('.integration.test.ts')
const isOutsideTests = (file: string) =>
  /\.md$|^\.claude\/|^scripts\/|^\.gitignore$|^biome\.json$|^\.dependency-cruiser\.cjs$/.test(file)
const isE2eHarness = (file: string) =>
  /^apps\/server\/src\/(testing\/(test-server|sso-test-server|testing)|fake-llm)\.ts$|^apps\/web\/(playwright\.config|e2e\/global-setup|e2e\/stack-ports)\.ts$/.test(
    file,
  )
const isWebAsset = (file: string) => /^apps\/web\/(index\.html|(src|public)\/.+\.(css|html|svg|png|ico))$/.test(file)
const integrationPreload = 'apps/server/src/testing/integration-setup.ts'

const [lint, typecheck, boundaries, cruise] = await fastChecks
const fastResults = [lint, typecheck, boundaries]
for (const result of fastResults) {
  console.log(`${result.exitCode === 0 ? '✓' : '✗'} ${result.label} (${result.seconds.toFixed(1)} s)`)
  if (result.exitCode !== 0) console.log(result.log)
}

const unit: Suite = { name: 'unit', files: new Set(), full: [] }
const integration: Suite = { name: 'integration', files: new Set(), full: [] }
const e2eFull: string[] = []
const e2eSpecs = new Set<string>()
const reasons = new Map<string, string[]>()
const select = (suite: Suite, testFile: string, changed: string) => {
  suite.files.add(testFile)
  reasons.set(testFile, [...(reasons.get(testFile) ?? []), changed])
}

let importersOf: Map<string, Set<string>> | undefined
const graphModules = new Set<string>()
try {
  if (cruise?.exitCode !== 0) throw new Error('depcruise failed')
  const cruised = JSON.parse(cruise.stdout) as Cruised
  importersOf = new Map()
  for (const module of cruised.modules) graphModules.add(module.source)
  for (const module of cruised.modules)
    for (const { resolved } of module.dependencies)
      importersOf.set(resolved, (importersOf.get(resolved) ?? new Set()).add(module.source))
} catch (error) {
  console.log(`The dependency graph could not be built (${(error as Error).message}): running every suite`)
}

const dependentsOf = (file: string) => {
  const reached = new Set([file])
  for (const current of reached) for (const importer of importersOf?.get(current) ?? []) reached.add(importer)
  return reached
}

for (const changed of changedFiles) {
  const isModule = /\.(ts|tsx)$/.test(changed) && /^(apps|packages)\//.test(changed)
  if (isOutsideTests(changed) || isWebAsset(changed)) continue
  if (!importersOf || !isModule) {
    unit.full.push(changed)
    integration.full.push(changed)
    e2eFull.push(changed)
    continue
  }
  if (!existsSync(`${repositoryRoot}${changed}`)) continue
  if (changed === integrationPreload) integration.full.push(changed)
  if (isE2eHarness(changed)) e2eFull.push(changed)
  if (!graphModules.has(changed) && !isUnitTest(changed) && !isIntegrationTest(changed)) {
    unit.full.push(changed)
    integration.full.push(changed)
    continue
  }
  for (const dependent of dependentsOf(changed)) {
    if (isUnitTest(dependent)) select(unit, dependent, changed)
    if (isIntegrationTest(dependent)) select(integration, dependent, changed)
    if (/^apps\/web\/e2e\/.+\.spec\.ts$/.test(dependent)) e2eSpecs.add(dependent)
  }
}

console.log(`\nBase ${base}: ${changedFiles.length} changed file(s)`)
for (const file of changedFiles) console.log(`  ${file}`)
const describe = (suite: Suite) => {
  if (suite.full.length > 0) return console.log(`\n${suite.name}: whole suite, because of ${suite.full.join(', ')}`)
  console.log(`\n${suite.name}: ${suite.files.size} file(s)`)
  for (const file of suite.files) console.log(`  ${file} ← ${reasons.get(file)?.join(', ')}`)
}
describe(unit)
describe(integration)
console.log(
  e2eFull.length > 0
    ? `\ne2e: whole suite, because of ${e2eFull.join(', ')}`
    : e2eSpecs.size > 0
      ? `\ne2e: Playwright --only-changed=${base}, which should select ${[...e2eSpecs].join(', ')}`
      : '\ne2e: no spec imports a changed module (app code reached only through the servers is left to check:all)',
)

const testResults = []
const testFiles = (suite: Suite) => [...suite.files].map((file) => `./${file}`)
if (unit.full.length > 0) testResults.push(runInherited('unit', ['bun', 'run', 'test']))
else if (unit.files.size > 0) testResults.push(runInherited('unit', ['bun', 'test', ...testFiles(unit)]))
const needsStack = integration.full.length > 0 || integration.files.size > 0
if (needsStack) runInherited('stack', ['bun', 'run', 'stack:up'])
if (integration.full.length > 0) testResults.push(runInherited('integration', ['bun', 'run', 'test:integration']))
else if (integration.files.size > 0)
  testResults.push(
    runInherited('integration', ['bun', 'test', '--preload', `./${integrationPreload}`, ...testFiles(integration)]),
  )
if (e2eFull.length > 0) testResults.push(runInherited('e2e', ['bun', 'run', 'test:e2e']))
else if (e2eSpecs.size > 0)
  testResults.push(runInherited('e2e', ['bun', 'run', 'test:e2e', `--only-changed=${base}`, '--pass-with-no-tests']))

const results = [...fastResults, ...testResults]
console.log(`\ncheck:related in ${((performance.now() - startedAt) / 1000).toFixed(1)} s`)
for (const result of results)
  console.log(`  ${result.exitCode === 0 ? '✓' : '✗'} ${result.label} (${result.seconds.toFixed(1)} s)`)
process.exit(results.some((result) => result.exitCode !== 0) ? 1 : 0)
