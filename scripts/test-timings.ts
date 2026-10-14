import { existsSync, readFileSync } from 'node:fs'

type Timed = { title: string; seconds: number }
type Spec = {
  title: string
  file: string
  line: number
  tests: { projectName: string; results: { duration: number }[] }[]
}
type Suite = { specs?: Spec[]; suites?: Suite[] }

const checkDirectory = new URL('../.check/', import.meta.url).pathname
const entities: Record<string, string> = { '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' }
const unescapeXml = (text: string) => text.replace(/&(quot|apos|lt|gt|amp);/g, (entity) => entities[entity] ?? entity)
const attributeOf = (tag: string, name: string) => unescapeXml(new RegExp(` ${name}="([^"]*)"`).exec(tag)?.[1] ?? '')

const report = (name: string, wallSeconds: number, tests: Timed[]) => {
  const summedSeconds = tests.reduce((total, test) => total + test.seconds, 0)
  console.log(
    `\n${name}: ${tests.length} tests, ${wallSeconds.toFixed(1)} s wall, ${summedSeconds.toFixed(1)} s summed`,
  )
  for (const test of tests.toSorted((first, second) => second.seconds - first.seconds).slice(0, 20))
    console.log(`  ${test.seconds.toFixed(1).padStart(6)} s  ${test.title}`)
}

const reportE2e = (path: string) => {
  const results = JSON.parse(readFileSync(path, 'utf8')) as Suite & { stats: { duration: number } }
  const testsByProject = new Map<string, Timed[]>()
  const walk = (suite: Suite) => {
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests) {
        const seconds = test.results.reduce((total, result) => total + result.duration, 0) / 1000
        const tests =
          testsByProject.get(test.projectName) ?? testsByProject.set(test.projectName, []).get(test.projectName)
        tests?.push({ title: `${spec.file}:${spec.line} ${spec.title}`, seconds })
      }
    for (const child of suite.suites ?? []) walk(child)
  }
  walk(results)
  for (const [project, tests] of testsByProject)
    report(`e2e ${project || 'default'} project`, results.stats.duration / 1000, tests)
}

const reportIntegration = (path: string, name: string) => {
  const xml = readFileSync(path, 'utf8')
  const tests = [...xml.matchAll(/<testcase [^>]*>/g)].map(([tag]) => ({
    title: `${attributeOf(tag, 'file')} ${attributeOf(tag, 'name')}`,
    seconds: Number(attributeOf(tag, 'time')),
  }))
  report(name, Number(attributeOf(/<testsuites [^>]*>/.exec(xml)?.[0] ?? '', 'time')), tests)
}

const files = process.argv.slice(2)
for (const file of files.length > 0 ? files : ['integration.xml', 'e2e-results.json']) {
  const path = `${checkDirectory}${file}`
  if (!existsSync(path)) continue
  if (file.endsWith('.json')) reportE2e(path)
  else reportIntegration(path, file.replace(/\.xml$/, ''))
}
