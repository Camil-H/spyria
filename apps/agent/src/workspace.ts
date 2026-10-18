import { copyFile, open, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, sep } from 'node:path'

const maximumEntries = 500
const maximumFileBytes = 256_000
const maximumPatchCharacters = 400_000
const maximumCommits = 200
const branchPattern = /^\w[\w./-]*$/
const commitPattern = /^[0-9a-f]{40}$/
const maximumBundleBytes = 20_000_000
const identityPattern = /^[^<>\n\0]+$/
const baseRef = 'refs/hq/base'
const pushedRef = 'refs/hq/pushed'

const git = async (cwd: string, args: string[], env: Record<string, string>, input = '') => {
  const child = Bun.spawn(['git', '-C', cwd, ...args], {
    env,
    stdin: new TextEncoder().encode(input),
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const output = await new Response(child.stdout).text()
  return (await child.exited) === 0 ? output : ''
}

const insideWorkspace = async (root: string, path: string) => {
  const [workspace, resolved] = await Promise.all(
    [root, join(root, path)].map((candidate) => realpath(candidate).catch(() => undefined)),
  )
  return workspace && (resolved === workspace || resolved?.startsWith(`${workspace}${sep}`)) ? resolved : undefined
}

export const treeOf = async (root: string, path: string, env: Record<string, string>) => {
  const directory = await insideWorkspace(root, path)
  const entries = directory
    ? (await readdir(directory, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.name !== '.git')
    : []
  const paths = entries.map((entry) => posix.join(path, entry.name))
  const ignored = new Set((await git(root, ['check-ignore', '--stdin'], env, paths.join('\n'))).split('\n'))
  const listed = entries
    .map((entry, index) => ({ name: entry.name, path: paths[index] ?? entry.name, isFolder: entry.isDirectory() }))
    .filter((entry) => !ignored.has(entry.path))
    .sort((first, second) => Number(second.isFolder) - Number(first.isFolder) || first.name.localeCompare(second.name))
  return { entries: listed.slice(0, maximumEntries), truncated: listed.length > maximumEntries }
}

export const fileOf = async (root: string, path: string) => {
  const file = await insideWorkspace(root, path)
  const handle = file && (await open(file).catch(() => undefined))
  if (!handle) return undefined
  try {
    const buffer = Buffer.alloc(maximumFileBytes + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const bytes = buffer.subarray(0, Math.min(bytesRead, maximumFileBytes))
    const isBinary = bytes.includes(0)
    return { content: isBinary ? '' : bytes.toString('utf8'), isBinary, truncated: bytesRead > maximumFileBytes }
  } catch {
    return undefined
  } finally {
    await handle.close()
  }
}

const baseRefOf = async (root: string, base: string, env: Record<string, string>) => {
  if (!branchPattern.test(base)) return undefined
  for (const ref of [baseRef, `refs/remotes/origin/${base}`])
    if ((await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], env)).trim()) return ref
  return undefined
}

export const changesOf = async (root: string, base: string, env: Record<string, string>) => {
  const ref = await baseRefOf(root, base, env)
  const mergeBase = ref ? (await git(root, ['merge-base', ref, 'HEAD'], env)).trim() : ''
  if (!mergeBase) return { patch: '', log: '', truncated: false }
  const index = join(tmpdir(), `hq-index-${crypto.randomUUID()}`)
  try {
    await copyFile(join(root, '.git', 'index'), index).catch(() => undefined)
    const indexEnvironment = { ...env, GIT_INDEX_FILE: index }
    await git(root, ['add', '--all', '--intent-to-add'], indexEnvironment)
    const [patch, log] = await Promise.all([
      git(root, ['diff', '--no-renames', '--no-color', mergeBase], indexEnvironment),
      git(root, ['log', `--max-count=${maximumCommits}`, '--format=%H%x1f%s%x1f%an%x1f%aI', `${mergeBase}..HEAD`], env),
    ])
    return {
      patch: patch.slice(0, maximumPatchCharacters),
      log,
      truncated: patch.length > maximumPatchCharacters,
    }
  } finally {
    await rm(index, { force: true })
  }
}

const gitBytes = async (cwd: string, args: string[], env: Record<string, string>) => {
  const child = Bun.spawn(['git', '-C', cwd, ...args], { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [bytes, errors] = await Promise.all([new Response(child.stdout).bytes(), new Response(child.stderr).text()])
  return { isDone: (await child.exited) === 0, bytes, errors }
}

export const bundleOf = async (
  root: string,
  { branch, prerequisite }: { branch?: unknown; prerequisite?: unknown },
  env: Record<string, string>,
) => {
  const isPrerequisite = typeof prerequisite === 'string' && commitPattern.test(prerequisite)
  if (typeof branch !== 'string' || !branchPattern.test(branch) || (prerequisite !== null && !isPrerequisite))
    return { failure: 'The bundle request is not valid' }
  const tip = (await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], env)).trim()
  if (!tip) return { failure: `The branch ${branch} has no commit in the runtime` }
  if (tip === prerequisite) return { bundle: '' }
  const isAncestor =
    isPrerequisite && (await gitBytes(root, ['merge-base', '--is-ancestor', prerequisite, tip], env)).isDone
  const bundled = await gitBytes(
    root,
    ['bundle', 'create', '-', `refs/heads/${branch}`, ...(isAncestor ? [`^${prerequisite}`] : [])],
    env,
  )
  if (!bundled.isDone) return { failure: `The branch could not be bundled: ${bundled.errors.trim()}` }
  if (bundled.bytes.length > maximumBundleBytes)
    return {
      failure: `The new commits weigh more than ${maximumBundleBytes / 1_000_000} MB; push them from your machine`,
    }
  return { bundle: Buffer.from(bundled.bytes).toString('base64') }
}

const countsAgainst = async (root: string, ref: string | undefined, env: Record<string, string>) => {
  const [behind, ahead] = ref
    ? (await git(root, ['rev-list', '--left-right', '--count', `${ref}...HEAD`], env)).trim().split('\t').map(Number)
    : []
  return ahead === undefined || behind === undefined || Number.isNaN(ahead) ? undefined : { ahead, behind }
}

export const statusOf = async (root: string, base: string, env: Record<string, string>) => {
  const ref = await baseRefOf(root, base, env)
  const [baseHead, toBase, toPushed, pushedLog, uncommitted] = await Promise.all([
    ref ? git(root, ['rev-parse', ref], env) : '',
    countsAgainst(root, ref, env),
    countsAgainst(root, pushedRef, env),
    git(root, ['log', '--walk-reflogs', '--max-count=1', '--format=%gd', '--date=unix', pushedRef], env),
    git(root, ['status', '--porcelain', '--no-renames', '--untracked-files=all', '-z'], env),
  ])
  const [, pushedSeconds] = /@\{(\d+)\}/.exec(pushedLog) ?? []
  return {
    ...(baseHead.trim() && { baseHead: baseHead.trim() }),
    ...(toBase && { aheadOfBase: toBase.ahead, behindBase: toBase.behind }),
    ...(toPushed && { aheadOfPushed: toPushed.ahead, behindPushed: toPushed.behind }),
    ...(pushedSeconds && { pushedAt: new Date(Number(pushedSeconds) * 1000).toISOString() }),
    uncommitted: uncommitted.split('\0').filter(Boolean).length,
  }
}

const authorEnvironmentOf = (author: unknown) => {
  const { name, email } = (author ?? {}) as { name?: unknown; email?: unknown }
  if (typeof name !== 'string' || typeof email !== 'string') return undefined
  if (!identityPattern.test(name) || !identityPattern.test(email)) return undefined
  return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email }
}

export const commitOf = async (
  root: string,
  { message, author }: { message?: unknown; author?: unknown },
  env: Record<string, string>,
) => {
  const authorEnvironment = authorEnvironmentOf(author)
  if (typeof message !== 'string' || !authorEnvironment) return { failure: 'The commit request is not valid' }
  if (!message.trim()) return { failure: 'Write a commit message' }
  await gitBytes(root, ['add', '--all'], env)
  if ((await gitBytes(root, ['diff', '--cached', '--quiet'], env)).isDone)
    return { failure: 'There is nothing to commit' }
  const committed = await gitBytes(root, ['commit', '--quiet', '-m', message.trim()], {
    ...env,
    ...authorEnvironment,
  })
  if (!committed.isDone) return { failure: `The commit failed: ${committed.errors.trim()}` }
  return { sha: (await git(root, ['rev-parse', 'HEAD'], env)).trim() }
}

const isCommit = async (root: string, sha: string, env: Record<string, string>) =>
  Boolean(await git(root, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], env))

const fetchedBase = async (root: string, base: string, head: string, bundle: string, env: Record<string, string>) => {
  if (!bundle)
    return (await isCommit(root, head, env)) && (await gitBytes(root, ['update-ref', baseRef, head], env)).isDone
  const file = join(tmpdir(), `hq-base-${crypto.randomUUID()}.bundle`)
  try {
    await Bun.write(file, Buffer.from(bundle, 'base64'))
    const heads = await git(root, ['bundle', 'list-heads', file], env)
    if (heads !== `${head} refs/heads/${base}\n`) return false
    if (!(await gitBytes(root, ['bundle', 'verify', '--quiet', file], env)).isDone) return false
    return (await gitBytes(root, ['fetch', '--quiet', '--no-tags', file, `+refs/heads/${base}:${baseRef}`], env)).isDone
  } finally {
    await rm(file, { force: true })
  }
}

export const mergeOf = async (
  root: string,
  { base, head, bundle, author }: { base?: unknown; head?: unknown; bundle?: unknown; author?: unknown },
  env: Record<string, string>,
) => {
  const authorEnvironment = authorEnvironmentOf(author)
  if (
    typeof base !== 'string' ||
    !branchPattern.test(base) ||
    typeof head !== 'string' ||
    !commitPattern.test(head) ||
    typeof bundle !== 'string' ||
    !authorEnvironment
  )
    return { failure: 'The update request is not valid' }
  if ((await git(root, ['status', '--porcelain'], env)).trim())
    return { failure: 'Commit the uncommitted changes before updating from base' }
  if (!(await fetchedBase(root, base, head, bundle, env)))
    return { failure: `The base branch ${base} could not be read from the bundle` }
  if ((await gitBytes(root, ['merge-base', '--is-ancestor', baseRef, 'HEAD'], env)).isDone) return { isUpToDate: true }
  const working = (await git(root, ['branch', '--show-current'], env)).trim()
  const merged = await gitBytes(
    root,
    ['merge', '--no-ff', '--no-edit', '-m', `Merge branch '${base}' into ${working}`, baseRef],
    { ...env, ...authorEnvironment },
  )
  if (merged.isDone) return { isUpToDate: false }
  const conflicts = (await git(root, ['diff', '--name-only', '--diff-filter=U'], env)).split('\n').filter(Boolean)
  await gitBytes(root, ['merge', '--abort'], env)
  return conflicts.length > 0 ? { conflicts } : { failure: `The merge failed: ${merged.errors.trim()}` }
}

export const pushedOf = async (root: string, { head }: { head?: unknown }, env: Record<string, string>) => {
  if (typeof head !== 'string' || !commitPattern.test(head)) return { failure: 'The pushed head is not valid' }
  if (!(await isCommit(root, head, env))) return { failure: 'The pushed head is not in the runtime' }
  await gitBytes(root, ['update-ref', '--create-reflog', '-m', 'pushed', pushedRef, head], env)
  return {}
}
