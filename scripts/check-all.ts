import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const isDocker = process.argv.includes('--docker')
const checkName = isDocker ? 'check:docker' : 'check:all'
const steps = isDocker
  ? ['stack:up', 'agent:build', 'test:docker:integration']
  : ['lint', 'typecheck', 'check:boundaries', 'test', 'check:bundle', 'stack:up', 'test:integration', 'test:e2e']
const timingFiles = isDocker ? ['integration-docker.xml'] : ['integration.xml', 'e2e-results.json']
const repositoryRoot = new URL('../', import.meta.url).pathname
const checkDirectory = `${repositoryRoot}.check/`
const logFile = `${checkDirectory}last-${checkName.replace(':', '-')}.log`
const summaryFile = `${checkDirectory}last-${checkName.replace(':', '-')}.json`

const git = (args: string[], env: Record<string, string> = {}) =>
  Bun.spawnSync(['git', ...args], { cwd: repositoryRoot, env: { ...process.env, ...env } })
    .stdout.toString()
    .trim()
const workingTreeOf = () => {
  const index = join(tmpdir(), `spyria-check-index-${process.pid}`)
  git(['read-tree', 'HEAD'], { GIT_INDEX_FILE: index })
  git(['add', '-A'], { GIT_INDEX_FILE: index })
  const tree = git(['write-tree'], { GIT_INDEX_FILE: index })
  rmSync(index, { force: true })
  return tree
}

if (process.argv.includes('--verify')) {
  const summary = await Bun.file(summaryFile).json()
  const tree = workingTreeOf()
  const matches = summary.tree === tree
  console.log(
    `${summaryFile}: exit ${summary.exitCode} at ${summary.finishedAt}; the tree ${matches ? 'matches' : `differs (run ${summary.tree}, now ${tree})`}`,
  )
  process.exit(matches && summary.exitCode === 0 ? 0 : 1)
}

mkdirSync(checkDirectory, { recursive: true })
writeFileSync(logFile, '')
for (const file of timingFiles) rmSync(`${checkDirectory}${file}`, { force: true })
const head = git(['rev-parse', 'HEAD'])
const fingerprint = git(['stash', 'create']) || head
const tree = workingTreeOf()
const startedAt = new Date()
const results: { step: string; exitCode: number; seconds: number }[] = []
const log = (text: string) => {
  process.stdout.write(text)
  appendFileSync(logFile, text)
}
log(`${checkName} on ${fingerprint} (HEAD ${head}, tree ${tree}) at ${startedAt.toISOString()}\n`)
for (const step of steps) {
  log(`\n▶ bun run ${step}\n`)
  const started = performance.now()
  const child = Bun.spawn(['bun', 'run', step], {
    cwd: repositoryRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const readers = [child.stdout.getReader(), child.stderr.getReader()]
  const pipe = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    const decoder = new TextDecoder()
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
      log(decoder.decode(chunk.value, { stream: true }))
  }
  const piped = Promise.all(readers.map(pipe)).then(() => true)
  const exitCode = await child.exited
  if (!(await Promise.race([piped, Bun.sleep(1_000).then(() => false)]))) {
    log(`\n${step} exited but a process it started still holds its output; not waiting for it\n`)
    for (const reader of readers) void reader.cancel()
  }
  results.push({ step, exitCode, seconds: Math.round((performance.now() - started) / 100) / 10 })
  if (exitCode !== 0) break
}
const exitCode = results.at(-1)?.exitCode ?? 1
log(Bun.spawnSync(['bun', 'scripts/test-timings.ts', ...timingFiles], { cwd: repositoryRoot }).stdout.toString())
const summary = {
  fingerprint,
  head,
  tree,
  isClean: fingerprint === head,
  exitCode,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  steps: results,
}
writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`)
log(`\n${checkName} ${exitCode === 0 ? 'passed' : 'failed'}\n`)
for (const result of results) log(`  ${result.exitCode === 0 ? '✓' : '✗'} ${result.step} (${result.seconds} s)\n`)
log(`Summary in ${summaryFile}\n`)
process.exit(exitCode)
