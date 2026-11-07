import { afterAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const installScript = new URL('../../../deploy/install.sh', import.meta.url).pathname
const work = mkdtempSync(join(tmpdir(), 'spyria-install-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))
const platform = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`

const releaseWith = (binary: string, listedChecksum?: string) => {
  const release = mkdtempSync(join(work, 'release-'))
  mkdirSync(join(release, 'latest/download'), { recursive: true })
  writeFileSync(join(release, `latest/download/spyria-${platform}`), binary)
  const checksum = listedChecksum ?? createHash('sha256').update(binary).digest('hex')
  writeFileSync(join(release, 'latest/download/spyria-checksums.txt'), `${checksum}  spyria-${platform}\n`)
  return release
}
const fakeTools = mkdtempSync(join(work, 'bin-'))
const fake = (name: string, script: string) => {
  writeFileSync(join(fakeTools, name), `#!/bin/sh\n${script}\n`)
  chmodSync(join(fakeTools, name), 0o755)
}
fake('curl', 'url=""; out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; -*) ;; *) url="$1" ;; esac; shift; done; cp "${url#file://}" "$out"')
fake('docker', 'exit 0')

const install = (release: string) => {
  const installDir = mkdtempSync(join(work, 'install-'))
  const result = Bun.spawnSync(['sh', installScript], {
    env: {
      PATH: `${fakeTools}:/usr/bin:/bin`,
      HOME: work,
      SPYRIA_DOWNLOAD_BASE: `file://${release}`,
      SPYRIA_INSTALL_DIR: installDir,
      SPYRIA_SKIP_SETUP: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { installDir, exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() }
}

test('install.sh downloads the binary of this platform, checks its checksum and installs it as spyria', () => {
  const { installDir, exitCode, output } = install(releaseWith('#!/bin/sh\necho spyria\n'))
  expect(output).toContain(`Installed spyria in ${installDir}`)
  expect(exitCode).toBe(0)
  expect(readFileSync(join(installDir, 'spyria'), 'utf8')).toBe('#!/bin/sh\necho spyria\n')
  expect(statSync(join(installDir, 'spyria')).mode & 0o777).toBe(0o755)
})

test('install.sh refuses a binary that does not match the published checksum, and installs nothing', () => {
  const { installDir, exitCode, output } = install(releaseWith('tampered', 'a'.repeat(64)))
  expect(exitCode).toBe(1)
  expect(output).toContain(`the download of spyria-${platform} does not match its checksum`)
  expect(() => statSync(join(installDir, 'spyria'))).toThrow()
})
