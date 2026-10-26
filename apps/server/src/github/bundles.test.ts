import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { branchBundle } from './bundles.ts'

const directory = mkdtempSync(join(tmpdir(), 'spyria-bundles-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const git = (...command: string[]) => {
  const result = Bun.spawnSync(
    ['git', '-c', 'init.defaultBranch=main', '-c', 'user.name=Alice', '-c', 'user.email=alice@example.com', ...command],
    { cwd: directory, stderr: 'pipe' },
  )
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

test('a branch bundle over 12 MB is refused while it streams, with the update-from-your-machine reason; a smaller one is sent whole', async () => {
  git('init', '-q', 'upstream')
  writeFileSync(join(directory, 'upstream', 'small.bin'), crypto.getRandomValues(new Uint8Array(1_000)))
  git('-C', 'upstream', 'add', '.')
  git('-C', 'upstream', 'commit', '-q', '-m', 'Small data')
  const url = `file://${join(directory, 'upstream')}`
  const fetchBase = (runtimeHeads: string[]) =>
    branchBundle({ url, token: 'unused', branch: 'main', baseBranch: 'main', runtimeHeads })
  const small = await fetchBase([])
  expect(small).toMatchObject({ head: git('-C', 'upstream', 'rev-parse', 'main') })
  const smallHead = String((small as { head: string }).head)
  writeFileSync(join(directory, 'small.bundle'), Buffer.from(String((small as { bundle: string }).bundle), 'base64'))
  expect(git('bundle', 'list-heads', 'small.bundle')).toBe(`${smallHead} refs/heads/main`)
  writeFileSync(join(directory, 'upstream', 'large.bin'), crypto.getRandomValues(new Uint8Array(12_100_000)))
  git('-C', 'upstream', 'add', '.')
  git('-C', 'upstream', 'commit', '-q', '-m', 'Large data')
  expect(await fetchBase([smallHead])).toEqual({
    failure: 'The new commits of main weigh more than 12 MB; bring them in from your machine',
  })
}, 30_000)

test('a branch bundle excludes what the runtime holds, falls back to the base for a branch it never saw, is empty when the runtime already has the head, and names a missing branch', async () => {
  git('init', '-q', 'feature-upstream')
  const upstream = join(directory, 'feature-upstream')
  const commit = (message: string) => {
    writeFileSync(join(upstream, `${message}.txt`), message)
    git('-C', 'feature-upstream', 'add', '.')
    git('-C', 'feature-upstream', 'commit', '-q', '-m', message)
    return git('-C', 'feature-upstream', 'rev-parse', 'HEAD')
  }
  const forkPoint = commit('base')
  git('-C', 'feature-upstream', 'checkout', '-q', '-b', 'feature')
  const featureHead = commit('feature')
  git('-C', 'feature-upstream', 'checkout', '-q', 'main')
  const runtimeBase = commit('later-base')
  const url = `file://${upstream}`
  const fetchFeature = (runtimeHeads: string[]) =>
    branchBundle({ url, token: 'unused', branch: 'feature', baseBranch: 'main', runtimeHeads })

  const thin = (await fetchFeature([runtimeBase, 'not-a-commit'])) as { head: string; bundle: string }
  expect(thin.head).toBe(featureHead)
  writeFileSync(join(directory, 'feature.bundle'), Buffer.from(thin.bundle, 'base64'))
  expect(git('bundle', 'list-heads', 'feature.bundle')).toBe(`${featureHead} refs/heads/feature`)
  const verified = Bun.spawnSync(['git', 'bundle', 'verify', join(directory, 'feature.bundle')], { cwd: upstream })
  expect(`${verified.stdout}${verified.stderr}`).toContain(forkPoint)
  expect(await fetchFeature([featureHead])).toEqual({ head: featureHead, bundle: '' })
  expect(await branchBundle({ url, token: 'unused', branch: 'gone', baseBranch: 'main', runtimeHeads: [] })).toEqual({
    failure: 'There is no branch gone on GitHub',
  })
}, 30_000)
