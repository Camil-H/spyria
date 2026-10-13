import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const steps = [
  'lint',
  'typecheck',
  'check:boundaries',
  'test',
  'check:bundle',
  'stack:up',
  'agent:build',
  'test:integration',
  'test:e2e',
]
const repositoryRoot = new URL('../', import.meta.url).pathname
const checkDirectory = `${repositoryRoot}.check/`
const logFile = `${checkDirectory}last-check-all.log`
const summaryFile = `${checkDirectory}last-check-all.json`

const git = (args: string[], env: Record<string, string> = {}) =>
  Bun.spawnSync(['git', ...args], { cwd: repositoryRoot, env: { ...process.env, ...env } })
    .stdout.toString()
    .trim()
const workingTreeOf = () => {
  const index = join(tmpdir(), `hq-check-index-${process.pid}`)
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
const head = git(['rev-parse', 'HEAD'])
const fingerprint = git(['stash', 'create']) || head
const tree = workingTreeOf()
const startedAt = new Date()
const results: { step: string; exitCode: number; seconds: number }[] = []
const log = (text: string) => {
  process.stdout.write(text)
  appendFileSync(logFile, text)
}
log(`check:all on ${fingerprint} (HEAD ${head}, tree ${tree}) at ${startedAt.toISOString()}\n`)
for (const step of steps) {
  log(`\n▶ bun run ${step}\n`)
  const started = performance.now()
  const child = Bun.spawn(['bun', 'run', step], {
    cwd: repositoryRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const pipe = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) log(decoder.decode(chunk, { stream: true }))
  }
  await Promise.all([pipe(child.stdout), pipe(child.stderr)])
  const exitCode = await child.exited
  results.push({ step, exitCode, seconds: Math.round((performance.now() - started) / 100) / 10 })
  if (exitCode !== 0) break
}
const exitCode = results.at(-1)?.exitCode ?? 1
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
log(`\ncheck:all ${exitCode === 0 ? 'passed' : 'failed'}\n`)
for (const result of results) log(`  ${result.exitCode === 0 ? '✓' : '✗'} ${result.step} (${result.seconds} s)\n`)
log(`Summary in ${summaryFile}\n`)
process.exit(exitCode)
