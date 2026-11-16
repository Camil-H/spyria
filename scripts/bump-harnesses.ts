import { readFileSync, writeFileSync } from 'node:fs'

export type HarnessId = 'claude-code' | 'codex' | 'pi'
export type Bump = { package: string; from: string; to: string; published: string[] }

const repositoryRoot = new URL('../', import.meta.url).pathname
const harnessesFile = `${repositoryRoot}apps/host/src/harnesses.json`
const piDirectory = `${repositoryRoot}apps/agent/pi/`
const piManifestFile = `${piDirectory}package.json`
const baseBranch = 'develop'

export const harnessNames: Record<HarnessId, string> = { 'claude-code': 'Claude Code', codex: 'Codex', pi: 'Pi' }
const harnessIds = Object.keys(harnessNames) as HarnessId[]

export const releaseTagUrls: Record<string, string> = {
  '@anthropic-ai/claude-code': 'https://github.com/anthropics/claude-code/releases/tag/v',
  '@agentclientprotocol/claude-agent-acp': 'https://github.com/agentclientprotocol/claude-agent-acp/releases/tag/v',
  '@openai/codex': 'https://github.com/openai/codex/releases/tag/rust-v',
  '@agentclientprotocol/codex-acp': 'https://github.com/agentclientprotocol/codex-acp/releases/tag/v',
  '@earendil-works/pi-coding-agent': 'https://github.com/earendil-works/pi/releases/tag/v',
}

const checklists: Record<HarnessId, string[]> = {
  'claude-code': [
    'On one machine, sign in to Claude Code with a real subscription (`spyria-host login claude-code`).',
    'Send one real prompt in a chat that runs on **Local · Claude Code**: it answers.',
  ],
  codex: [
    'On one machine, sign in to Codex with a real ChatGPT plan (`spyria-host login codex`).',
    'Send one real prompt in a chat that runs on **Local · Codex**: it answers.',
  ],
  pi: [
    'Rebuild the runtime image (`bun run agent:build`) and restart the server.',
    'With a real API key, send one real prompt in a chat that runs on **Spyria runtime**: it answers.',
  ],
}

const isStable = (version: string) => /^\d+\.\d+\.\d+$/.test(version)

export const publishedAfter = (versions: string[], pinned: string) =>
  versions.filter((version) => isStable(version) && Bun.semver.order(version, pinned) > 0).sort(Bun.semver.order)

export const bumpsOf = (pins: Record<string, string>, versionsByPackage: Record<string, string[]>): Bump[] =>
  Object.entries(pins).flatMap(([name, pinned]) => {
    const published = publishedAfter(versionsByPackage[name] ?? [], pinned)
    const latest = published.at(-1)
    return latest ? [{ package: name, from: pinned, to: latest, published }] : []
  })

export const branchOf = (harness: HarnessId) => `deps/harness-${harness}`

export const titleOf = (harness: HarnessId, programPackage: string, bumps: Bump[]) => {
  const program = bumps.find((bump) => bump.package === programPackage)
  const shown = program ?? bumps[0]
  if (!shown) throw new Error(`No bump for ${harnessNames[harness]}`)
  return `build: ${harnessNames[harness]}${program ? '' : ' adapter'} ${shown.from} → ${shown.to}`
}

const releaseNotesOf = ({ package: name, published }: Bump) => {
  const tagUrl = releaseTagUrls[name]
  const links = published.map((version) => (tagUrl ? `[${version}](${tagUrl}${version})` : version))
  return `- \`${name}\`: ${links.join(', ')}`
}

export const bodyOf = (harness: HarnessId, bumps: Bump[]) =>
  [
    `The weekly harness check found newer versions of ${harnessNames[harness]} on npm (pre-releases are ignored).`,
    '',
    '| Package | From | To |',
    '|---|---|---|',
    ...bumps.map((bump) => `| \`${bump.package}\` | ${bump.from} | ${bump.to} |`),
    '',
    '## Release notes',
    '',
    ...bumps.map(releaseNotesOf),
    '',
    '## Before merging',
    '',
    'CI runs every check the new pins reach, `check:docker` included. Then, by hand:',
    '',
    ...checklists[harness].map((step) => `- [ ] ${step}`),
    '',
    'Nothing merges automatically. See "Harness bump pull requests" in `docs/guides/development.md`.',
  ].join('\n')

type HarnessPins = Record<'claude-code' | 'codex', { packages: Record<string, string> }>
const readJson = <Shape>(file: string): Shape => JSON.parse(readFileSync(file, 'utf8'))
const writeJson = (file: string, value: unknown) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)

const pinsOf = (harness: HarnessId): Record<string, string> =>
  harness === 'pi'
    ? readJson<{ dependencies: Record<string, string> }>(piManifestFile).dependencies
    : readJson<HarnessPins>(harnessesFile)[harness].packages

const run = (command: string[], options: { cwd?: string; stdin?: string } = {}) => {
  const result = Bun.spawnSync(command, {
    cwd: options.cwd ?? repositoryRoot,
    stdin: options.stdin === undefined ? 'ignore' : Buffer.from(options.stdin),
    stdout: 'pipe',
    stderr: 'inherit',
  })
  if (result.exitCode !== 0) throw new Error(`${command.slice(0, 3).join(' ')} exited with ${result.exitCode}`)
  return result.stdout.toString().trim()
}

const pin = (harness: HarnessId, bumps: Bump[]) => {
  if (harness === 'pi') {
    const manifest = readJson<{ dependencies: Record<string, string> }>(piManifestFile)
    for (const bump of bumps) manifest.dependencies[bump.package] = bump.to
    writeJson(piManifestFile, manifest)
    run(['npm', 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: piDirectory })
    return
  }
  const pins = readJson<HarnessPins>(harnessesFile)
  for (const bump of bumps) pins[harness].packages[bump.package] = bump.to
  writeJson(harnessesFile, pins)
}

const versionsOf = async (name: string) => {
  const response = await fetch(`https://registry.npmjs.org/${name}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  })
  if (!response.ok) throw new Error(`npm answered ${response.status} for ${name}`)
  return Object.keys(((await response.json()) as { versions: Record<string, unknown> }).versions)
}

const bumpsFor = async (harness: HarnessId) => {
  const pins = pinsOf(harness)
  const versions = await Promise.all(Object.keys(pins).map(async (name) => [name, await versionsOf(name)] as const))
  return { programPackage: Object.keys(pins)[0] ?? '', bumps: bumpsOf(pins, Object.fromEntries(versions)) }
}

const openPullRequestOf = (branch: string) =>
  run([
    ...['gh', 'pr', 'list', '--head', branch, '--base', baseBranch, '--state', 'open'],
    ...['--json', 'number', '--jq', '.[0].number // empty'],
  ]) || undefined

const openOrUpdatePullRequest = (harness: HarnessId, title: string, bumps: Bump[]) => {
  const branch = branchOf(harness)
  const openPullRequest = openPullRequestOf(branch)
  run(['git', 'fetch', '--quiet', 'origin', baseBranch, ...(openPullRequest ? [branch] : [])])
  run(['git', 'checkout', '--quiet', '--force', '-B', branch, `origin/${openPullRequest ? branch : baseBranch}`])
  pin(harness, bumps)
  const changed = run(['git', 'status', '--porcelain']) !== ''
  if (changed) {
    run(['git', 'commit', '--quiet', '--all', '--message', title])
    run(['git', 'push', '--quiet', ...(openPullRequest ? [] : ['--force']), 'origin', branch])
  }
  const body = bodyOf(harness, bumps)
  if (openPullRequest) run(['gh', 'pr', 'edit', openPullRequest, '--title', title, '--body-file', '-'], { stdin: body })
  else
    run(['gh', 'pr', 'create', '--base', baseBranch, '--head', branch, '--title', title, '--body-file', '-'], {
      stdin: body,
    })
  if (changed) run(['gh', 'workflow', 'run', 'ci.yml', '--ref', branch])
  run(['git', 'checkout', '--quiet', '--force', '--detach', `origin/${baseBranch}`])
  console.log(`${openPullRequest ? `Updated #${openPullRequest}` : 'Opened a pull request'}: ${title}`)
}

const closeStalePullRequest = (harness: HarnessId) => {
  const openPullRequest = openPullRequestOf(branchOf(harness))
  if (!openPullRequest) return
  run([
    ...['gh', 'pr', 'close', openPullRequest, '--delete-branch'],
    ...['--comment', `${baseBranch} already pins the latest versions of ${harnessNames[harness]}.`],
  ])
  console.log(`Closed #${openPullRequest}: ${baseBranch} already pins the latest versions`)
}

if (import.meta.main) {
  const openPullRequests = process.argv.includes('--pull-requests')
  if (openPullRequests) {
    run(['git', 'fetch', '--quiet', 'origin', baseBranch])
    run(['git', 'checkout', '--quiet', '--force', '--detach', `origin/${baseBranch}`])
  }
  for (const harness of harnessIds) {
    const { programPackage, bumps } = await bumpsFor(harness)
    if (bumps.length === 0) {
      console.log(`${harnessNames[harness]} is on its latest versions`)
      if (openPullRequests) closeStalePullRequest(harness)
      continue
    }
    const title = titleOf(harness, programPackage, bumps)
    if (openPullRequests) openOrUpdatePullRequest(harness, title, bumps)
    else console.log(`${title}\n${bumps.map((bump) => `  ${bump.package} ${bump.from} → ${bump.to}`).join('\n')}`)
  }
}
