import { existsSync, writeFileSync } from 'node:fs'

type Suite = { name: string; files: Set<string>; full: string[] }
type Cruised = { modules: { source: string; dependencies: { resolved: string }[] }[] }

const argumentAfter = (flag: string) => {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}
const baseRef = argumentAfter('--base') ?? 'HEAD'
const planFile = argumentAfter('--plan')
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

const base = output(['git', 'merge-base', baseRef, 'HEAD']).trim()
const changedFiles = [
  ...new Set([
    ...output(['git', 'diff', '--name-only', base]).split('\n'),
    ...output(['git', 'ls-files', '--others', '--exclude-standard']).split('\n'),
  ]),
].filter(Boolean)

const dependencyGraph = run('dependency graph', [
  'bunx',
  'depcruise',
  'apps',
  'packages',
  '--config',
  '.dependency-cruiser.cjs',
  '--output-type',
  'json',
])
const fastChecks = planFile
  ? Promise.resolve([])
  : Promise.all([
      run('lint', ['bun', 'run', 'lint']),
      run('typecheck', ['bun', 'run', 'typecheck']),
      run('boundaries', ['bun', 'run', 'check:boundaries']),
    ])

const isUnitTest = (file: string) =>
  /^(packages|apps\/server|apps\/host|apps\/agent)\/.+\.test\.tsx?$/.test(file) &&
  !/\.(integration|docker)\.test\.ts$/.test(file)
const isIntegrationTest = (file: string) => file.endsWith('.integration.test.ts')
const isE2eSpec = (file: string) => /^apps\/web\/e2e\/.+\.spec\.ts$/.test(file)
const isTestCode = (file: string) => /\.test\.tsx?$/.test(file) || /^apps\/web\/e2e\//.test(file)
const isOutsideTests = (file: string) =>
  /\.md$|^\.claude\/|^\.agents\/|^\.github\/|^scripts\/|^\.gitignore$|^biome\.json$|^\.dependency-cruiser\.cjs$/.test(
    file,
  )
const isE2eHarness = (file: string) =>
  /^apps\/server\/src\/testing\/(test-server|sso-test-server|testing|fake-llm)\.ts$|^apps\/web\/(playwright\.config|e2e\/global-setup|e2e\/stack-ports|e2e\/platform-gate)\.ts$/.test(
    file,
  )
const isWebAsset = (file: string) => /^apps\/web\/(index\.html|(src|public)\/.+\.(css|html|svg|png|ico))$/.test(file)
const isInWebBundle = (file: string) =>
  /^(apps\/web\/(src|public|index\.html|vite\.config\.ts|package\.json)|packages\/|package\.json$|bun\.lock$)/.test(
    file,
  ) && !isTestCode(file)
const isDockerArea = (file: string) =>
  /^(apps\/(host|agent)\/|infra\/|apps\/server\/src\/(runtime-hosts|agent-bridge)\/|apps\/server\/src\/(spyria-agent-image|testing\/harnesses)\.ts$|scripts\/(agent-image|check-trust|build-cache)\.ts$)/.test(
    file,
  )
const e2eSegmentsByArea: [RegExp, string[]][] = [
  [/^packages\/conversation\//, ['02-chats', '03-sharing', '04-agent', '07-dev-mode']],
  [/^packages\/panel\//, ['02-chats', '03-sharing', '07-dev-mode']],
  [/^packages\/profile\//, ['06-connectors']],
  [/^packages\/runtime\//, ['04-agent', '05-machines']],
  [/^packages\/usage\//, ['08-admin']],
  [/^apps\/server\/src\/(agent-bridge|runtime-hosts)\//, ['04-agent', '05-machines']],
  [/^apps\/server\/src\/github\//, ['07-dev-mode']],
  [/^apps\/server\/src\/auth\//, ['01-access']],
  [/^apps\/(agent|host)\//, ['04-agent', '05-machines', '07-dev-mode']],
]
const e2eSegmentsOf = (file: string) => e2eSegmentsByArea.find(([area]) => area.test(file))?.[1]
const integrationPreload = 'apps/server/src/testing/integration-setup.ts'

const [fastResults, cruise] = await Promise.all([fastChecks, dependencyGraph])
for (const result of fastResults) {
  console.log(`${result.exitCode === 0 ? '✓' : '✗'} ${result.label} (${result.seconds.toFixed(1)} s)`)
  if (result.exitCode !== 0) console.log(result.log)
}

const unit: Suite = { name: 'unit', files: new Set(), full: [] }
const integration: Suite = { name: 'integration', files: new Set(), full: [] }
const e2e: Suite = { name: 'e2e', files: new Set(), full: [] }
const e2eSegments = new Map<string, string[]>()
const dockerReasons: string[] = []
const reasons = new Map<string, string[]>()
const select = (suite: Suite, testFile: string, changed: string) => {
  suite.files.add(testFile)
  reasons.set(testFile, [...(reasons.get(testFile) ?? []), changed])
}
const selectE2eArea = (changed: string) => {
  const segments = e2eSegmentsOf(changed)
  if (!segments) return e2e.full.push(changed)
  for (const segment of segments) e2eSegments.set(segment, [...(e2eSegments.get(segment) ?? []), changed])
}

let importersOf: Map<string, Set<string>> | undefined
const graphModules = new Set<string>()
try {
  if (cruise.exitCode !== 0) throw new Error('depcruise failed')
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
  if (isDockerArea(changed)) dockerReasons.push(changed)
  const isModule = /\.(ts|tsx)$/.test(changed) && /^(apps|packages)\//.test(changed)
  if (isOutsideTests(changed)) continue
  if (isWebAsset(changed)) {
    e2e.full.push(changed)
    continue
  }
  if (!importersOf || !isModule) {
    unit.full.push(changed)
    integration.full.push(changed)
    e2e.full.push(changed)
    continue
  }
  if (!existsSync(`${repositoryRoot}${changed}`)) continue
  if (changed === integrationPreload) integration.full.push(changed)
  if (isE2eHarness(changed)) e2e.full.push(changed)
  else if (!isTestCode(changed)) selectE2eArea(changed)
  if (!graphModules.has(changed) && !isUnitTest(changed) && !isIntegrationTest(changed)) {
    unit.full.push(changed)
    integration.full.push(changed)
    continue
  }
  for (const dependent of dependentsOf(changed)) {
    if (isUnitTest(dependent)) select(unit, dependent, changed)
    if (isIntegrationTest(dependent)) select(integration, dependent, changed)
    if (isE2eSpec(dependent)) select(e2e, dependent, changed)
  }
}

const playwrightPathOf = (file: string) => file.replace(/^apps\/web\//, '')
const segmentOf = (spec: string) => /^apps\/web\/e2e\/([^/]+)\//.exec(spec)?.[1] ?? ''
const e2eSelection =
  e2e.full.length > 0
    ? ('all' as const)
    : [
        ...[...e2eSegments.keys()].map((segment) => `e2e/${segment}`),
        ...[...e2e.files].filter((spec) => !e2eSegments.has(segmentOf(spec))).map(playwrightPathOf),
      ]
const changedSpecs = changedFiles.filter((file) => isE2eSpec(file) && existsSync(`${repositoryRoot}${file}`))
const bundleReasons = changedFiles.filter(isInWebBundle)

console.log(`\nBase ${baseRef} (${base.slice(0, 12)}): ${changedFiles.length} changed file(s)`)
for (const file of changedFiles) console.log(`  ${file}`)
const describe = (suite: Suite) => {
  if (suite.full.length > 0) return console.log(`\n${suite.name}: whole suite, because of ${suite.full.join(', ')}`)
  console.log(`\n${suite.name}: ${suite.files.size} file(s)`)
  for (const file of suite.files) console.log(`  ${file} ← ${reasons.get(file)?.join(', ')}`)
}
describe(unit)
describe(integration)
if (e2eSelection === 'all') console.log(`\ne2e: whole suite, because of ${e2e.full.join(', ')}`)
else {
  console.log(`\ne2e: ${e2eSelection.length} segment(s) or spec(s)`)
  for (const [segment, changed] of e2eSegments) console.log(`  e2e/${segment} ← ${changed.join(', ')}`)
  for (const spec of e2e.files)
    if (!e2eSegments.has(segmentOf(spec))) console.log(`  ${playwrightPathOf(spec)} ← ${reasons.get(spec)?.join(', ')}`)
}
console.log(dockerReasons.length > 0 ? `\ndocker: yes, because of ${dockerReasons.join(', ')}` : '\ndocker: no')
console.log(bundleReasons.length > 0 ? `bundle: yes, because of ${bundleReasons.join(', ')}` : 'bundle: no')

const selectionOf = (suite: Suite) => (suite.full.length > 0 ? ('all' as const) : [...suite.files])
if (planFile) {
  const plan = {
    base,
    changedFiles,
    unit: selectionOf(unit),
    integration: selectionOf(integration),
    e2e: e2eSelection,
    e2eRepeat: changedSpecs.map(playwrightPathOf),
    docker: dockerReasons.length > 0,
    bundle: bundleReasons.length > 0,
  }
  writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`)
  console.log(`\nPlan written to ${planFile}`)
  process.exit(0)
}

const testResults = []
const testFiles = (suite: Suite) => [...suite.files].map((file) => `./${file}`)
if (unit.full.length > 0) testResults.push(runInherited('unit', ['bun', 'run', 'test']))
else if (unit.files.size > 0) testResults.push(runInherited('unit', ['bun', 'test', ...testFiles(unit)]))
if (integration.full.length > 0) testResults.push(runInherited('integration', ['bun', 'run', 'test:integration']))
else if (integration.files.size > 0)
  testResults.push(
    runInherited('integration', ['bun', 'test', '--preload', `./${integrationPreload}`, ...testFiles(integration)]),
  )
if (e2eSelection === 'all') testResults.push(runInherited('e2e', ['bun', 'run', 'test:e2e']))
else if (e2eSelection.length > 0)
  testResults.push(runInherited('e2e', ['bun', 'run', 'test:e2e', '--', ...e2eSelection]))
if (dockerReasons.length > 0)
  console.log('\nThe change reaches the host, the agent or the images: run check:docker too')

const results = [...fastResults, ...testResults]
console.log(`\ncheck:related in ${((performance.now() - startedAt) / 1000).toFixed(1)} s`)
for (const result of results)
  console.log(`  ${result.exitCode === 0 ? '✓' : '✗'} ${result.label} (${result.seconds.toFixed(1)} s)`)
process.exit(results.some((result) => result.exitCode !== 0) ? 1 : 0)
