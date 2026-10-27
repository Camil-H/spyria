import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Selection = 'all' | string[]
type Plan = { unit: Selection; integration: Selection; e2e: Selection; e2eRepeat: string[] }

const [suite, shard = '1/1'] = process.argv.slice(2)
const plan = JSON.parse(process.env.PLAN ?? '{}') as Plan
const repositoryRoot = new URL('../', import.meta.url).pathname
const integrationPreload = './apps/server/src/testing/integration-setup.ts'
const junitFile = join(tmpdir(), `spyria-ci-${suite}.xml`)
const junitReporter = ['--reporter=junit', `--reporter-outfile=${junitFile}`]
const annotationLines = 20
const fromRoot = (files: string[]) => files.map((file) => `./${file}`)

const commandOf = (suite: string | undefined) => {
  if (suite === 'unit')
    return plan.unit === 'all'
      ? ['bun', 'run', 'test', ...junitReporter]
      : ['bun', 'test', ...fromRoot(plan.unit), ...junitReporter]
  if (suite === 'integration')
    return plan.integration === 'all'
      ? ['bun', 'run', 'test:integration', ...junitReporter]
      : ['bun', 'test', '--preload', integrationPreload, ...fromRoot(plan.integration), ...junitReporter]
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

const entities: Record<string, string> = { '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' }
const unescapeXml = (text: string) =>
  text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&(quot|apos|lt|gt|amp);/g, (entity) => entities[entity] ?? entity)
const attributeOf = (tag: string, name: string) => unescapeXml(new RegExp(` ${name}="([^"]*)"`).exec(tag)?.[1] ?? '')
const escapeAnnotationData = (text: string) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
const escapeAnnotationProperty = (text: string) => escapeAnnotationData(text).replace(/:/g, '%3A').replace(/,/g, '%2C')

const annotateFailures = () => {
  if (!existsSync(junitFile)) return
  const failures = readFileSync(junitFile, 'utf8').matchAll(
    /<testcase( [^>]*)>\s*<failure [^>]*>([\s\S]*?)<\/failure>/g,
  )
  for (const [, testcase = '', failure = ''] of failures) {
    const message = unescapeXml(failure).trim().split('\n').slice(0, annotationLines).join('\n')
    const location = `file=${attributeOf(testcase, 'file')},line=${attributeOf(testcase, 'line')}`
    console.log(
      `::error ${location},title=${escapeAnnotationProperty(attributeOf(testcase, 'name'))}::${escapeAnnotationData(message)}`,
    )
  }
}

const command = commandOf(suite)
console.log(`▶ ${command.join(' ')}`)
const { exitCode } = Bun.spawnSync(command, { cwd: repositoryRoot, stdout: 'inherit', stderr: 'inherit' })
if (exitCode !== 0) annotateFailures()
process.exit(exitCode)
