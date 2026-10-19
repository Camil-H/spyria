import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentTestbed } from './testing.ts'

const { started } = createAgentTestbed()
const directory = mkdtempSync(join(tmpdir(), 'spyria-agent-workspace-'))
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
git(workspace, 'checkout', '-q', '-b', 'spyria/work')
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
  git(changes, 'checkout', '-q', '-b', 'spyria/fix')
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

test('a bundle carries the working branch from a prerequisite the remote has, or whole when none; it holds no credential and refuses bad requests', async () => {
  const bundled = join(directory, 'bundled')
  git(directory, 'clone', '-q', source, bundled)
  git(bundled, 'checkout', '-q', '-b', 'spyria/bundle')
  write(bundled, { 'src/app.ts': 'export const total = 2\n' })
  git(bundled, 'commit', '-q', '-am', 'Fix the total')
  const base = Bun.spawnSync(['git', 'rev-parse', 'main'], { cwd: bundled }).stdout.toString().trim()
  const tip = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: bundled }).stdout.toString().trim()
  const { call } = started({ workspaceDirectory: bundled })
  const headsOf = async (prerequisite: string | null) => {
    const { status, body } = await call('POST', '/api/workspace/bundle', { branch: 'spyria/bundle', prerequisite })
    expect(status).toBe(200)
    const file = join(directory, `bundle-${prerequisite ?? 'whole'}`)
    writeFileSync(file, Buffer.from(String(body.bundle), 'base64'))
    return Bun.spawnSync(['git', 'bundle', 'list-heads', file]).stdout.toString()
  }
  expect(await headsOf(base)).toBe(`${tip} refs/heads/spyria/bundle\n`)
  const verified = Bun.spawnSync(['git', 'bundle', 'verify', join(directory, `bundle-${base}`)], { cwd: source })
  expect(verified.stderr.toString()).toContain(base)
  expect(await headsOf(null)).toBe(`${tip} refs/heads/spyria/bundle\n`)
  expect(await headsOf('0'.repeat(40))).toBe(`${tip} refs/heads/spyria/bundle\n`)
  expect((await call('POST', '/api/workspace/bundle', { branch: 'spyria/bundle', prerequisite: tip })).body).toEqual({
    bundle: '',
  })
  for (const request of [
    { branch: '--all', prerequisite: null },
    { branch: 'spyria/bundle', prerequisite: 'HEAD~1' },
  ])
    expect(await call('POST', '/api/workspace/bundle', request)).toEqual({
      status: 422,
      body: { error: 'The bundle request is not valid' },
    })
  expect((await call('POST', '/api/workspace/bundle', { branch: 'spyria/missing', prerequisite: null })).body).toEqual({
    error: 'The branch spyria/missing has no commit in the runtime',
  })
})

const author = { name: 'Alice', email: 'alice@example.com' }
const revisionOf = (cwd: string, revision: string) =>
  Bun.spawnSync(['git', 'rev-parse', revision], { cwd }).stdout.toString().trim()
const outputOf = (cwd: string, ...command: string[]) => Bun.spawnSync(['git', ...command], { cwd }).stdout.toString()
const baseBundleOf = (upstream: string, prerequisite?: string) => {
  const file = join(directory, `base-${crypto.randomUUID()}.bundle`)
  git(upstream, 'bundle', 'create', file, 'refs/heads/main', ...(prerequisite ? [`^${prerequisite}`] : []))
  return Bun.file(file)
    .bytes()
    .then((bytes) => Buffer.from(bytes).toString('base64'))
}
const workingCopyOf = (name: string, upstream: string) => {
  const copy = join(directory, name)
  git(directory, 'clone', '-q', upstream, copy)
  git(copy, 'checkout', '-q', '-b', `spyria/${name}`)
  return copy
}

test('the status counts commits against the base and the pushed head, uncommitted files and the last push time', async () => {
  const copy = workingCopyOf('status', source)
  write(copy, { 'src/app.ts': 'export const total = 2\n' })
  git(copy, 'commit', '-q', '-am', 'Fix the total')
  const { call } = started({ workspaceDirectory: copy })
  expect((await call('GET', '/api/workspace/status?base=main')).body).toEqual({
    baseHead: revisionOf(source, 'main'),
    aheadOfBase: 1,
    behindBase: 0,
    uncommitted: 0,
  })
  expect(await call('POST', '/api/workspace/pushed', { head: revisionOf(copy, 'HEAD') })).toEqual({
    status: 200,
    body: {},
  })
  write(copy, { 'src/app.ts': 'export const total = 3\n' })
  git(copy, 'commit', '-q', '-am', 'Raise the total')
  write(copy, { 'README.md': '# app 2\n', 'docs/new.md': 'new\n' })
  const { body } = await call('GET', '/api/workspace/status?base=main')
  expect(body).toMatchObject({ aheadOfBase: 2, behindBase: 0, aheadOfPushed: 1, behindPushed: 0, uncommitted: 2 })
  expect(Date.now() - Date.parse(String(body.pushedAt))).toBeLessThan(60_000)
  expect((await call('GET', '/api/workspace/status?base=--all')).body).toEqual({
    aheadOfPushed: 1,
    behindPushed: 0,
    pushedAt: body.pushedAt,
    uncommitted: 2,
  })
  for (const head of ['HEAD', '0'.repeat(40)])
    expect((await call('POST', '/api/workspace/pushed', { head })).status).toBe(422)
})

test('a commit records every uncommitted change with the given author; an empty message, nothing to commit or a bad author is refused', async () => {
  const copy = workingCopyOf('commit', source)
  const { call } = started({ workspaceDirectory: copy })
  expect((await call('POST', '/api/workspace/commit', { message: 'Nothing', author })).body).toEqual({
    error: 'There is nothing to commit',
  })
  write(copy, { 'src/app.ts': 'export const total = 4\n', 'docs/new.md': 'new\n' })
  expect((await call('POST', '/api/workspace/commit', { message: '  ', author })).body).toEqual({
    error: 'Write a commit message',
  })
  for (const request of [
    { message: 'Bad', author: { name: 'Alice', email: 'alice@example.com>\nevil' } },
    { message: 'Bad', author: { name: 'Alice' } },
    { message: 42, author },
  ])
    expect(await call('POST', '/api/workspace/commit', request)).toEqual({
      status: 422,
      body: { error: 'The commit request is not valid' },
    })
  const committed = await call('POST', '/api/workspace/commit', { message: 'Raise the total\n', author })
  expect(committed).toEqual({ status: 200, body: { sha: revisionOf(copy, 'HEAD') } })
  expect(outputOf(copy, 'log', '-1', '--format=%s|%an|%ae|%cn')).toBe('Raise the total|Alice|alice@example.com|Alice\n')
  expect(outputOf(copy, 'status', '--porcelain')).toBe('')
})

test('an update fetches the base from a thin bundle into refs/hq/base only and merges it with a merge commit', async () => {
  const upstream = workingCopyOf('upstream-merge', source)
  git(upstream, 'checkout', '-q', 'main')
  const copy = workingCopyOf('merge', upstream)
  write(copy, { 'src/app.ts': 'export const total = 2\n' })
  git(copy, 'commit', '-q', '-am', 'Fix the total')
  const previousBase = revisionOf(upstream, 'main')
  write(upstream, { 'docs/base.md': 'from base\n' })
  git(upstream, 'add', '.')
  git(upstream, 'commit', '-q', '-m', 'Add base docs')
  const head = revisionOf(upstream, 'main')
  const branchesBefore = outputOf(
    copy,
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/heads',
    'refs/remotes',
  )
  const { call } = started({ workspaceDirectory: copy })
  const bundle = await baseBundleOf(upstream, previousBase)
  expect((await call('GET', '/api/workspace/status?base=main')).body).toMatchObject({ baseHead: previousBase })
  write(copy, { 'scratch.txt': 'dirty\n' })
  expect((await call('POST', '/api/workspace/merge', { base: 'main', head, bundle, author })).body).toEqual({
    error: 'Commit the uncommitted changes before updating from base',
  })
  rmSync(join(copy, 'scratch.txt'))
  expect(await call('POST', '/api/workspace/merge', { base: 'main', head, bundle, author })).toEqual({
    status: 200,
    body: { isUpToDate: false },
  })
  expect(outputOf(copy, 'log', '-1', '--format=%s|%an|%P')).toBe(
    `Merge branch 'main' into spyria/merge|Alice|${revisionOf(copy, 'HEAD~1')} ${head}\n`,
  )
  expect(revisionOf(copy, 'refs/hq/base')).toBe(head)
  expect(outputOf(copy, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes')).toBe(
    branchesBefore.replace(/refs\/heads\/spyria\/merge \w+/, `refs/heads/spyria/merge ${revisionOf(copy, 'HEAD')}`),
  )
  expect((await call('GET', '/api/workspace/status?base=main')).body).toMatchObject({
    baseHead: head,
    aheadOfBase: 2,
    behindBase: 0,
  })
  expect(String((await call('GET', '/api/workspace/changes?base=main')).body.patch)).not.toContain('docs/base.md')
  expect((await call('POST', '/api/workspace/merge', { base: 'main', head, bundle: '', author })).body).toEqual({
    isUpToDate: true,
  })
})

test('a conflicting update is aborted, leaving the working copy clean, and names the conflicting paths', async () => {
  const upstream = workingCopyOf('upstream-conflict', source)
  git(upstream, 'checkout', '-q', 'main')
  const copy = workingCopyOf('conflict', upstream)
  write(copy, { 'src/app.ts': 'export const total = 2\n' })
  git(copy, 'commit', '-q', '-am', 'Fix the total')
  write(upstream, { 'src/app.ts': 'export const total = 3\n' })
  git(upstream, 'commit', '-q', '-am', 'Raise the total on main')
  const head = revisionOf(upstream, 'main')
  const before = revisionOf(copy, 'HEAD')
  const { call } = started({ workspaceDirectory: copy })
  const bundle = await baseBundleOf(upstream)
  expect(await call('POST', '/api/workspace/merge', { base: 'main', head, bundle, author })).toEqual({
    status: 200,
    body: { conflicts: ['src/app.ts'] },
  })
  expect(revisionOf(copy, 'HEAD')).toBe(before)
  expect(outputOf(copy, 'status', '--porcelain')).toBe('')
  expect(existsSync(join(copy, '.git/MERGE_HEAD'))).toBe(false)
})

test('an update refuses a bundle carrying other refs, a mismatched head and invalid requests', async () => {
  const upstream = workingCopyOf('upstream-refused', source)
  git(upstream, 'checkout', '-q', 'main')
  const copy = workingCopyOf('refused', upstream)
  const previousBase = revisionOf(upstream, 'main')
  write(upstream, { 'docs/base.md': 'from base\n' })
  git(upstream, 'add', '.')
  git(upstream, 'commit', '-q', '-m', 'Add base docs')
  const head = revisionOf(upstream, 'main')
  const otherRefs = join(directory, 'other-refs.bundle')
  git(upstream, 'bundle', 'create', otherRefs, 'refs/heads/main', 'refs/heads/spyria/upstream-refused')
  const otherBundle = Buffer.from(await Bun.file(otherRefs).bytes()).toString('base64')
  const { call } = started({ workspaceDirectory: copy })
  for (const request of [
    { base: 'main', head, bundle: otherBundle, author },
    { base: 'main', head: previousBase, bundle: await baseBundleOf(upstream), author },
    { base: 'main', head: '0'.repeat(40), bundle: '', author },
  ])
    expect((await call('POST', '/api/workspace/merge', request)).body).toEqual({
      error: 'The base branch main could not be read from the bundle',
    })
  expect(Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', 'refs/hq/base'], { cwd: copy }).exitCode).toBe(1)
  for (const request of [
    { base: '--all', head, bundle: '', author },
    { base: 'main', head: 'HEAD', bundle: '', author },
    { base: 'main', head, author },
    { base: 'main', head, bundle: '', author: { name: 'Alice', email: '' } },
  ])
    expect(await call('POST', '/api/workspace/merge', request)).toEqual({
      status: 422,
      body: { error: 'The update request is not valid' },
    })
})
