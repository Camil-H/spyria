import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { baseBundle } from './bundles.ts'

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

test('a base bundle over 12 MB is refused while it streams, with the update-from-your-machine reason; a smaller one is sent whole', async () => {
  git('init', '-q', 'upstream')
  writeFileSync(join(directory, 'upstream', 'small.bin'), crypto.getRandomValues(new Uint8Array(1_000)))
  git('-C', 'upstream', 'add', '.')
  git('-C', 'upstream', 'commit', '-q', '-m', 'Small data')
  const url = `file://${join(directory, 'upstream')}`
  const fetchBase = (runtimeBaseHead: string | null) =>
    baseBundle({ url, token: 'unused', baseBranch: 'main', runtimeBaseHead })
  const small = await fetchBase(null)
  expect(small).toMatchObject({ head: git('-C', 'upstream', 'rev-parse', 'main') })
  const smallHead = String((small as { head: string }).head)
  writeFileSync(join(directory, 'small.bundle'), Buffer.from(String((small as { bundle: string }).bundle), 'base64'))
  expect(git('bundle', 'list-heads', 'small.bundle')).toBe(`${smallHead} refs/heads/main`)
  writeFileSync(join(directory, 'upstream', 'large.bin'), crypto.getRandomValues(new Uint8Array(12_100_000)))
  git('-C', 'upstream', 'add', '.')
  git('-C', 'upstream', 'commit', '-q', '-m', 'Large data')
  expect(await fetchBase(smallHead)).toEqual({
    failure: "The base branch's new commits weigh more than 12 MB; update from your machine",
  })
}, 30_000)
