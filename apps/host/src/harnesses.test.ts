import { expect, test } from 'bun:test'
import { type Docker, DockerError } from './docker.ts'
import {
  harnessEnvironment,
  harnessFolderOf,
  harnessIds,
  installContainerBodyOf,
  installFailureOf,
  installHarness,
  installScriptOf,
  isHarnessInstalled,
  pinnedPackagesOf,
} from './harnesses.ts'

const image = `sha256:${'a'.repeat(64)}`

test('the pinned harnesses are keyed by the harness ids, each at exact versions', () => {
  expect(harnessIds).toEqual(['claude-code', 'codex'])
  for (const harness of harnessIds)
    for (const pinned of pinnedPackagesOf(harness)) expect(pinned).toMatch(/^@?[\w/.-]+@\d+\.\d+\.\d+$/)
})

test('a harness folder is named by a hash of its pinned list, so a new pin gets a new folder', () => {
  expect(harnessFolderOf('claude-code')).toMatch(/^\/harnesses\/claude-code\/[0-9a-f]{12}$/)
  expect(harnessFolderOf('codex')).toMatch(/^\/harnesses\/codex\/[0-9a-f]{12}$/)
  expect(harnessFolderOf('claude-code').split('/').at(-1)).not.toBe(harnessFolderOf('codex').split('/').at(-1))
})

test('the session environment points PATH and the executables at the current folder of each harness', () => {
  expect(harnessEnvironment).toEqual([
    'PATH=/harnesses/claude-code/current/bin:/harnesses/codex/current/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'CLAUDE_CODE_EXECUTABLE=/harnesses/claude-code/current/bin/claude',
    'CODEX_PATH=/harnesses/codex/current/bin/codex',
  ])
})

test('the install script installs the pinned list once into its folder, switches current to it and prunes every other folder of that harness', () => {
  const hash = harnessFolderOf('codex').split('/').at(-1)
  const script = installScriptOf('codex', 'http://registry.test:4873')
  expect(script).toContain(`if [ ! -e ${hash}/.installed ]; then`)
  expect(script).toContain(
    `npm install -g --no-fund --no-audit --loglevel=error --color=false --no-progress --prefix ${hash}.partial --registry http://registry.test:4873 ${pinnedPackagesOf('codex').join(' ')}`,
  )
  expect(script).toContain(`ln -sfn ${hash} current.next\nmv -T current.next current`)
  expect(script).toEndWith(`find . -mindepth 1 -maxdepth 1 ! -name ${hash} ! -name current -exec rm -rf {} +`)
  expect(installScriptOf('codex', '')).not.toContain('--registry')
})

test('the install container runs as uid 10001 with only the harnesses volume, writable, and the network', () => {
  expect(installContainerBodyOf('spyria-', image, 'claude-code')).toMatchObject({
    Image: image,
    User: '10001:10001',
    Entrypoint: ['sh', '-c', installScriptOf('claude-code')],
    HostConfig: {
      CapDrop: ['ALL'],
      ReadonlyRootfs: true,
      NetworkMode: 'bridge',
      Mounts: [{ Type: 'volume', Source: 'spyria-harnesses', Target: '/harnesses', ReadOnly: false }],
    },
  })
})

test("a failed install keeps npm's error lines without the log path, and falls back to the first lines", () => {
  const output = [
    'npm error code E404',
    'npm error 404 Not Found - GET http://registry.test/@openai%2fcodex - Not found',
    'npm error 404',
    'npm error 404  The requested resource could not be found.',
    'npm error A complete log of this run can be found in: /home/openhands/.npm/_logs/debug-0.log',
  ].join('\r\n')
  expect(installFailureOf(output)).toBe(
    'code E404\n404 Not Found - GET http://registry.test/@openai%2fcodex - Not found\n404  The requested resource could not be found.',
  )
  expect(installFailureOf('sh: 1: npm: not found\none\ntwo\nthree\n')).toBe('sh: 1: npm: not found\none\ntwo')
  expect(installFailureOf('\x1b[1G\x1b[0K\x1b[1mnpm\x1b[22m \x1b[31merror\x1b[39m code E404\r\n')).toBe('code E404')
  expect(installFailureOf('')).toBe('npm install failed')
  expect(installFailureOf(`npm error ${'x'.repeat(1000)}`)).toHaveLength(400)
})

test('a harness is installed when its folder marker is in the volume', async () => {
  const docker = (async (_method: string, path: string) => {
    if (path.includes(`${harnessFolderOf('codex')}/.installed`)) return ''
    throw new DockerError(404, 'Could not find the file')
  }) as Docker
  expect(await isHarnessInstalled(docker, 'spyria-rt-1', 'codex')).toBe(true)
  expect(await isHarnessInstalled(docker, 'spyria-rt-1', 'claude-code')).toBe(false)
})

test("two installs of one harness at once share one container, and a failure carries npm's reason and removes it", async () => {
  const calls: string[] = []
  const docker = (async (method: string, path: string) => {
    calls.push(`${method} ${path.split('?')[0]}`)
    if (path.endsWith('/wait')) return { StatusCode: 1 }
    if (path.includes('/logs')) return 'npm error code E404\r\nnpm error 404 Not Found\r\n'
    return {}
  }) as Docker
  const installs = [
    installHarness(docker, 'spyria-', image, 'codex'),
    installHarness(docker, 'spyria-', image, 'codex'),
  ]
  for (const install of installs) await expect(install).rejects.toThrow('code E404\n404 Not Found')
  expect(calls.filter((call) => call.startsWith('POST /containers/create'))).toHaveLength(1)
  expect(calls.at(-1)).toBe('DELETE /containers/spyria-harness-install-codex')
})
