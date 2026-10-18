import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentTestbed } from './testing.ts'

const { started } = createAgentTestbed()
const directory = mkdtempSync(join(tmpdir(), 'hq-agent-workspace-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const git = (cwd: string, ...command: string[]) => {
  const result = Bun.spawnSync(
    ['git', '-c', 'init.defaultBranch=main', '-c', 'user.name=Agent', '-c', 'user.email=agent@example.com', ...command],
    { cwd, stderr: 'pipe' },
  )
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}
const write = (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
}

const source = join(directory, 'source')
write(source, { 'README.md': '# app\n', 'src/app.ts': 'export const total = 1\n', '.gitignore': 'node_modules/\n' })
git(source, 'init', '-q')
git(source, 'add', '.')
git(source, 'commit', '-q', '-m', 'Initial commit')
const workspace = join(directory, 'workspace')
git(directory, 'clone', '-q', source, workspace)
git(workspace, 'checkout', '-q', '-b', 'hq/work')
write(directory, { 'secret.txt': 'outside' })

const read = async (path: string, key?: string) => {
  const { call } = started({ workspaceDirectory: workspace })
  return call('GET', path, undefined, key)
}

test('the tree lists one directory, folders first, without .git and ignored files; reads need the session key', async () => {
  write(workspace, { 'node_modules/left-pad/index.js': '', 'src/util/math.ts': '' })
  expect((await read('/api/workspace/tree')).body).toEqual({
    entries: [
      { name: 'src', path: 'src', isFolder: true },
      { name: '.gitignore', path: '.gitignore', isFolder: false },
      { name: 'README.md', path: 'README.md', isFolder: false },
    ],
    truncated: false,
  })
  expect((await read('/api/workspace/tree?path=src')).body.entries).toEqual([
    { name: 'util', path: 'src/util', isFolder: true },
    { name: 'app.ts', path: 'src/app.ts', isFolder: false },
  ])
  expect((await read('/api/workspace/tree?path=..')).body).toEqual({ entries: [], truncated: false })
  expect((await read('/api/workspace/tree', 'wrong-key')).status).toBe(401)
})

test('a large directory is capped with a truncated mark', async () => {
  write(workspace, Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`many/file-${index}.txt`, ''])))
  const { body } = await read('/api/workspace/tree?path=many')
  expect(body.truncated).toBe(true)
  expect((body.entries as unknown[]).length).toBe(500)
})

test('a file read returns its text, refuses paths outside the workspace and marks binary and truncated files', async () => {
  expect((await read('/api/workspace/file?path=src/app.ts')).body).toEqual({
    content: 'export const total = 1\n',
    isBinary: false,
    truncated: false,
  })
  symlinkSync(join(directory, 'secret.txt'), join(workspace, 'escape.txt'))
  for (const path of ['../secret.txt', 'escape.txt', '/etc/hosts', 'missing.txt'])
    expect((await read(`/api/workspace/file?path=${encodeURIComponent(path)}`)).status).toBe(404)
  writeFileSync(join(workspace, 'image.bin'), Buffer.from([137, 80, 0, 1]))
  expect((await read('/api/workspace/file?path=image.bin')).body).toEqual({
    content: '',
    isBinary: true,
    truncated: false,
  })
  writeFileSync(join(workspace, 'large.txt'), 'x'.repeat(300_000))
  const large = (await read('/api/workspace/file?path=large.txt')).body
  expect(large.truncated).toBe(true)
  expect(String(large.content).length).toBe(256_000)
})

test('changes are the diff against the base branch with commits, uncommitted edits and new files, without ignored files', async () => {
  const changes = join(directory, 'changes')
  git(directory, 'clone', '-q', source, changes)
  git(changes, 'checkout', '-q', '-b', 'hq/fix')
  write(changes, { 'src/app.ts': 'export const total = 2\n' })
  git(changes, 'commit', '-q', '-am', 'Fix the total')
  write(changes, { 'README.md': '# app\nFixed.\n', 'src/new.ts': 'export {}\n', 'node_modules/x.js': '' })
  const { call } = started({ workspaceDirectory: changes })
  const { body } = await call('GET', '/api/workspace/changes?base=main')
  const patch = String(body.patch)
  expect(patch).toContain('diff --git a/README.md b/README.md')
  expect(patch).toContain('+Fixed.')
  expect(patch).toContain('-export const total = 1\n+export const total = 2')
  expect(patch).toContain('diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644')
  expect(patch).not.toContain('node_modules')
  expect(body.truncated).toBe(false)
  expect(String(body.log).trim().split('\x1f').slice(1, 3)).toEqual(['Fix the total', 'Agent'])
  const status = Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: changes }).stdout.toString()
  expect(status).toContain('?? src/new.ts')
  for (const base of ['missing', '--output=x', ''])
    expect((await call('GET', `/api/workspace/changes?base=${encodeURIComponent(base)}`)).body).toEqual({
      patch: '',
      log: '',
      truncated: false,
    })
})
