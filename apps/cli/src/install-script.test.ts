import { afterAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  writeFileSync(join(release, 'latest/download/spyria-checksums.txt.sigstore.json'), '{"bundle":"of the release"}')
  return release
}
const fakeTools = mkdtempSync(join(work, 'bin-'))
const fake = (name: string, script: string) => {
  writeFileSync(join(fakeTools, name), `#!/bin/sh\n${script}\n`)
  chmodSync(join(fakeTools, name), 0o755)
}
fake(
  'curl',
  'url=""; out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; -*) ;; *) url="$1" ;; esac; shift; done; cp "$(echo "$url" | sed "s|^file://||")" "$out"',
)
fake('docker', 'exit 0')
const cosignCalls = join(work, 'cosign-calls')
const cosignOf = (exitCode: number, reason = '') => {
  const tools = mkdtempSync(join(work, 'cosign-'))
  writeFileSync(
    join(tools, 'cosign'),
    `#!/bin/sh\nfor argument in "$@"; do case "$argument" in /*) basename "$argument" ;; *) echo "$argument" ;; esac; done > "${cosignCalls}"\ncat "$4" >> "${cosignCalls}"\necho "${reason}" >&2\nexit ${exitCode}\n`,
  )
  chmodSync(join(tools, 'cosign'), 0o755)
  return tools
}
const verifyingCosign = cosignOf(0)
const refusingCosign = cosignOf(1, 'Error: none of the expected identities matched what was in the certificate')

const install = (
  release: string,
  { cosign, environment = {} }: { cosign?: string; environment?: Record<string, string> } = {},
) => {
  const installDir = mkdtempSync(join(work, 'install-'))
  const result = Bun.spawnSync(['sh', installScript], {
    env: {
      PATH: [fakeTools, ...(cosign ? [cosign] : []), '/usr/bin', '/bin'].join(':'),
      HOME: work,
      SPYRIA_DOWNLOAD_BASE: `file://${release}`,
      SPYRIA_INSTALL_DIR: installDir,
      SPYRIA_SKIP_SETUP: '1',
      ...environment,
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

test('install.sh checks with cosign that the checksums were signed by the Publish workflow of the repository, then installs', () => {
  rmSync(cosignCalls, { force: true })
  const { installDir, exitCode, output } = install(releaseWith('#!/bin/sh\necho spyria\n'), { cosign: verifyingCosign })
  expect(exitCode).toBe(0)
  expect(output).toContain(`Installed spyria in ${installDir}`)
  expect(output).not.toContain('cosign is missing')
  expect(readFileSync(cosignCalls, 'utf8').split('\n')).toEqual([
    'verify-blob',
    'checksums.txt',
    '--bundle',
    'checksums.sigstore.json',
    '--certificate-identity-regexp',
    '^https://github.com/Camil-H/spyria/\\.github/workflows/publish\\.yml@refs/tags/v',
    '--certificate-oidc-issuer',
    'https://token.actions.githubusercontent.com',
    '{"bundle":"of the release"}',
  ])
})

test('install.sh refuses checksums whose signature cosign does not verify, and installs nothing', () => {
  const { installDir, exitCode, output } = install(releaseWith('#!/bin/sh\necho spyria\n'), { cosign: refusingCosign })
  expect(exitCode).toBe(1)
  expect(output).toContain('Error: none of the expected identities matched what was in the certificate')
  expect(output).toContain(
    'cosign could not verify that the Publish workflow of Camil-H/spyria signed the checksums of this release',
  )
  expect(() => statSync(join(installDir, 'spyria'))).toThrow()
})

test('with cosign, install.sh refuses a release that publishes no signature of its checksums', () => {
  const release = releaseWith('#!/bin/sh\necho spyria\n')
  rmSync(join(release, 'latest/download/spyria-checksums.txt.sigstore.json'))
  const { installDir, exitCode, output } = install(release, { cosign: verifyingCosign })
  expect(exitCode).toBe(1)
  expect(output).toContain('the release publishes no signature of its checksums')
  expect(() => statSync(join(installDir, 'spyria'))).toThrow()
})

test('without cosign, install.sh says the signature is not checked, and refuses to install when SPYRIA_REQUIRE_SIGNATURE=1', () => {
  const unchecked = install(releaseWith('#!/bin/sh\necho spyria\n'))
  expect(unchecked.exitCode).toBe(0)
  expect(unchecked.output).toContain("cosign is missing, so the release's signature is not checked")
  const required = install(releaseWith('#!/bin/sh\necho spyria\n'), { environment: { SPYRIA_REQUIRE_SIGNATURE: '1' } })
  expect(required.exitCode).toBe(1)
  expect(required.output).toContain(
    'cosign is missing, and SPYRIA_REQUIRE_SIGNATURE=1 asks for the signature to be checked',
  )
  expect(() => statSync(join(required.installDir, 'spyria'))).toThrow()
})

test('install.sh refuses a binary that does not match the published checksum, and installs nothing', () => {
  const { installDir, exitCode, output } = install(releaseWith('tampered', 'a'.repeat(64)))
  expect(exitCode).toBe(1)
  expect(output).toContain(`the download of spyria-${platform} does not match its checksum`)
  expect(() => statSync(join(installDir, 'spyria'))).toThrow()
})

test('install.sh removes its download folder before it hands the terminal over to spyria setup', () => {
  const temporary = mkdtempSync(join(work, 'tmp-'))
  const installDir = mkdtempSync(join(work, 'install-'))
  const command = ['sh', installScript]
  const inTerminal =
    process.platform === 'darwin'
      ? ['script', '-q', '/dev/null', ...command]
      : ['script', '-qec', command.join(' '), '/dev/null']
  const result = Bun.spawnSync(inTerminal, {
    env: {
      PATH: `${fakeTools}:/usr/bin:/bin`,
      HOME: work,
      TMPDIR: temporary,
      SPYRIA_DOWNLOAD_BASE: `file://${releaseWith('#!/bin/sh\necho "setup ran with $*"\n')}`,
      SPYRIA_INSTALL_DIR: installDir,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(result.stdout.toString()).toContain('setup ran with setup')
  expect(result.exitCode).toBe(0)
  expect(readdirSync(temporary)).toEqual([])
})
