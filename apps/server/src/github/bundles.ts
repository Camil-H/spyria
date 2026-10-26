import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BundleOf } from '@spyria/conversation/server'

type Push = { url: string; token: string; branch: string; baseBranch: string; bundleOf: BundleOf }
type BranchFetch = { url: string; token: string; branch: string; baseBranch: string; runtimeHeads: string[] }

const shownOutputLines = 10
const commitPattern = /^[0-9a-f]{40}$/
const maximumBundleBytes = 12_000_000
const missingRemoteRef = /couldn't find remote ref/
const lastLinesOf = (output: string) => output.trimEnd().split('\n').slice(-shownOutputLines).join('\n')

const gitEnvironmentOf = (home: string, url: string, token: string) => {
  const { origin, protocol } = new URL(url)
  const settings = [
    ['core.hooksPath', '/dev/null'],
    ['protocol.allow', 'never'],
    [`protocol.${protocol.slice(0, -1)}.allow`, 'always'],
    ['protocol.file.allow', 'always'],
    ['credential.helper', ''],
    [
      `http.${origin}/.extraHeader`,
      `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    ],
  ]
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(settings.length),
    ...Object.fromEntries(
      settings.flatMap(([key = '', value = ''], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
      ]),
    ),
  }
}

type InRepository = (...args: string[]) => Promise<{ isDone: boolean; stdout: string; output: string }>
type GitChildInRepository = (...args: string[]) => Bun.Subprocess<'ignore', 'pipe', 'pipe'>

const inTemporaryRepository = async <Result>(
  url: string,
  token: string,
  work: (inRepository: InRepository, directory: string, gitChildInRepository: GitChildInRepository) => Promise<Result>,
) => {
  const directory = await mkdtemp(join(tmpdir(), 'spyria-git-'))
  const repository = join(directory, 'repository.git')
  const env = gitEnvironmentOf(directory, url, token)
  const gitChild = (...args: string[]) =>
    Bun.spawn(['git', ...args], { cwd: directory, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const git = async (...args: string[]) => {
    const child = gitChild(...args)
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { isDone: (await child.exited) === 0, stdout, output: `${stdout}${stderr}` }
  }
  try {
    await git('init', '--quiet', '--bare', repository)
    return await work(
      (...args) => git('-C', repository, ...args),
      directory,
      (...args) => gitChild('-C', repository, ...args),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export const pushBundle = ({ url, token, branch, baseBranch, bundleOf }: Push) =>
  inTemporaryRepository(url, token, async (inRepository, directory) => {
    const branchRef = `refs/heads/${branch}`
    const listed = await inRepository('ls-remote', url, branchRef, `refs/heads/${baseBranch}`)
    if (!listed.isDone) return { failure: `GitHub refused the push: ${lastLinesOf(listed.output)}` }
    const remoteHeads = new Map(listed.stdout.split('\n').map((line) => line.split('\t').reverse() as [string, string]))
    const prerequisiteRef = remoteHeads.has(branchRef) ? branchRef : `refs/heads/${baseBranch}`
    const prerequisite = remoteHeads.get(prerequisiteRef) ?? null
    const bundled = await bundleOf(branch, prerequisite)
    if ('failure' in bundled) return { failure: bundled.failure }
    if (bundled.bundle === '') return { head: remoteHeads.get(branchRef) }
    const bundle = join(directory, 'branch.bundle')
    await writeFile(bundle, Buffer.from(bundled.bundle, 'base64'))
    const heads = await inRepository('bundle', 'list-heads', bundle)
    const [head, ...otherHeads] = heads.stdout.trim().split('\n')
    if (!heads.isDone || otherHeads.length > 0 || head?.split(' ')[1] !== branchRef)
      return { failure: 'The runtime sent a bundle for other branches' }
    if (prerequisite)
      await inRepository('fetch', '--quiet', '--depth=1', url, `${prerequisiteRef}:refs/spyria/prerequisite`)
    const verified = await inRepository('bundle', 'verify', '--quiet', bundle)
    if (!verified.isDone) return { failure: `The runtime's bundle is not valid: ${lastLinesOf(verified.output)}` }
    const fetched = await inRepository('fetch', '--quiet', bundle, `${branchRef}:${branchRef}`)
    if (!fetched.isDone) return { failure: `The runtime's bundle could not be read: ${lastLinesOf(fetched.output)}` }
    const pushed = await inRepository('push', '--quiet', '--no-verify', url, `${branchRef}:${branchRef}`)
    return pushed.isDone
      ? { head: head.split(' ')[0] }
      : { failure: `The branch could not be pushed: ${lastLinesOf(pushed.output)}` }
  })

const commitsKnownTo = async (inRepository: InRepository, commits: string[]) => {
  const known = await Promise.all(
    commits.map(
      async (commit) => (await inRepository('rev-parse', '--verify', '--quiet', `${commit}^{commit}`)).isDone,
    ),
  )
  return commits.filter((_, index) => known[index])
}

export const branchBundle = ({ url, token, branch, baseBranch, runtimeHeads }: BranchFetch) =>
  inTemporaryRepository(url, token, async (inRepository, _directory, gitChildInRepository) => {
    const branchRef = `refs/heads/${branch}`
    const fetched = await inRepository('fetch', '--quiet', '--no-tags', url, `${branchRef}:${branchRef}`)
    if (!fetched.isDone)
      return {
        failure: missingRemoteRef.test(fetched.output)
          ? `There is no branch ${branch} on GitHub`
          : `GitHub refused the fetch: ${lastLinesOf(fetched.output)}`,
      }
    const head = (await inRepository('rev-parse', '--verify', branchRef)).stdout.trim()
    const candidates = [...new Set(runtimeHeads.filter((commit) => commitPattern.test(commit)))]
    const knownOnBranch = await commitsKnownTo(inRepository, candidates)
    const isBaseNeeded = knownOnBranch.length === 0 && candidates.length > 0 && branch !== baseBranch
    if (isBaseNeeded)
      await inRepository('fetch', '--quiet', '--no-tags', url, `refs/heads/${baseBranch}:refs/spyria/base`)
    const known = isBaseNeeded ? await commitsKnownTo(inRepository, candidates) : knownOnBranch
    const containing = await Promise.all(
      known.map(async (commit) => (await inRepository('merge-base', '--is-ancestor', head, commit)).isDone),
    )
    if (containing.includes(true)) return { head, bundle: '' }
    const bundling = gitChildInRepository('bundle', 'create', '-', branchRef, ...known.map((commit) => `^${commit}`))
    const bundlingErrors = new Response(bundling.stderr).text()
    const chunks: Uint8Array[] = []
    let bundleBytes = 0
    for await (const chunk of bundling.stdout) {
      bundleBytes += chunk.length
      if (bundleBytes > maximumBundleBytes) {
        bundling.kill()
        await bundling.exited
        return {
          failure: `The new commits of ${branch} weigh more than ${maximumBundleBytes / 1_000_000} MB; bring them in from your machine`,
        }
      }
      chunks.push(chunk)
    }
    if ((await bundling.exited) !== 0)
      return { failure: `The branch ${branch} could not be bundled: ${lastLinesOf(await bundlingErrors)}` }
    return { head, bundle: Buffer.concat(chunks).toString('base64') }
  })
