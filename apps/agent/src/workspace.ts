import { copyFile, open, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, sep } from 'node:path'

const maximumEntries = 500
const maximumFileBytes = 256_000
const maximumPatchCharacters = 400_000
const maximumCommits = 200
const branchPattern = /^\w[\w./-]*$/

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

export const changesOf = async (root: string, base: string, env: Record<string, string>) => {
  const mergeBase = branchPattern.test(base)
    ? (await git(root, ['merge-base', `origin/${base}`, 'HEAD'], env)).trim()
    : ''
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
