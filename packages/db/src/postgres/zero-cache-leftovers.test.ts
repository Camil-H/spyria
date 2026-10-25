import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isProcessGroupGone, stopLeftoverZeroCache } from './testing.ts'

const stubbornZeroCache = (directory: string) => {
  const cli = join(directory, 'node_modules/@rocicorp/zero/out/zero/src/cli.js')
  mkdirSync(join(cli, '..'), { recursive: true })
  writeFileSync(
    cli,
    `process.on('SIGTERM', () => {})
require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' })
setInterval(() => {}, 1000)
`,
  )
  const zeroCache = spawn('node', [cli], { detached: true, stdio: 'ignore' })
  return zeroCache.pid ?? 0
}

test('a zero-cache left by an earlier run is stopped with its whole process group, even when it ignores SIGTERM; an unrelated process named in the pid file is left alone', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'spyria-zero-leftover-'))
  const appId = `spyrialeftover${crypto.randomUUID().slice(0, 8)}`
  const pidFile = join(tmpdir(), `spyria-zero-${appId}.pid`)
  try {
    const groupId = stubbornZeroCache(directory)
    await Bun.sleep(300)
    writeFileSync(pidFile, String(groupId))
    await stopLeftoverZeroCache(appId)
    expect(isProcessGroupGone(groupId)).toBe(true)
    expect(await Bun.file(pidFile).exists()).toBe(false)

    const unrelated = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    unrelated.unref()
    writeFileSync(pidFile, String(unrelated.pid))
    await stopLeftoverZeroCache(appId)
    expect(isProcessGroupGone(unrelated.pid ?? 0)).toBe(false)
    process.kill(-(unrelated.pid ?? 0), 'SIGKILL')
  } finally {
    rmSync(directory, { recursive: true, force: true })
    rmSync(pidFile, { force: true })
  }
}, 20_000)
