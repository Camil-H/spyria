import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const testHarnessesVolume = 'spyria-test-harnesses'
export const testHarnessEnvironment = [
  'PATH=/harnesses/claude-code/current/bin:/harnesses/codex/current/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  'CLAUDE_CODE_EXECUTABLE=/harnesses/claude-code/current/bin/claude',
  'CODEX_PATH=/harnesses/codex/current/bin/codex',
]

export const requireTestHarnesses = () => {
  if (Bun.spawnSync(['docker', 'volume', 'inspect', testHarnessesVolume]).exitCode !== 0)
    throw new Error(`The ${testHarnessesVolume} volume is missing: run bun run agent:build`)
}

const pinsFile = new URL('../../../host/src/harnesses.json', import.meta.url).pathname
const stubAgent = new URL('../../../agent/fixtures/stub-acp-agent.mjs', import.meta.url).pathname
export const pinnedPackagesOf = (harness: string): Record<string, string> =>
  JSON.parse(readFileSync(pinsFile, 'utf8'))[harness].packages

const stubBinOf = (packageName: string) => ({
  [packageName
    .split('/')
    .at(-1)
    ?.replace(/^claude-code$/, 'claude') ?? '']: 'agent.mjs',
})

const tarballOf = (directory: string, packageName: string, version: string) => {
  const packageDirectory = join(directory, 'package')
  rmSync(packageDirectory, { recursive: true, force: true })
  mkdirSync(packageDirectory)
  const bin = stubBinOf(packageName)
  writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({ name: packageName, version, bin }))
  writeFileSync(join(packageDirectory, 'stub-acp-agent.mjs'), readFileSync(stubAgent))
  writeFileSync(join(packageDirectory, 'agent.mjs'), "#!/usr/bin/env node\nawait import('./stub-acp-agent.mjs')\n")
  const tarball = join(directory, 'package.tgz')
  if (Bun.spawnSync(['tar', '-czf', tarball, '-C', directory, 'package']).exitCode !== 0)
    throw new Error(`Could not pack ${packageName}`)
  return { bin, bytes: readFileSync(tarball) }
}

export const startFakeNpmRegistry = (packages: Record<string, string>) => {
  const directory = mkdtempSync(join(tmpdir(), 'spyria-test-registry-'))
  const tarballs = new Map(
    Object.entries(packages).map(([packageName, version]) => [
      packageName,
      { version, ...tarballOf(directory, packageName, version) },
    ]),
  )
  const requested: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '0.0.0.0',
    fetch: (request): Response => {
      const name = decodeURIComponent(new URL(request.url).pathname.slice(1))
      requested.push(name)
      const tarballName = name.startsWith('tarballs/') ? name.slice('tarballs/'.length) : undefined
      const found = tarballs.get(tarballName ?? name)
      if (!found) return Response.json({ error: 'Not found' }, { status: 404 })
      if (tarballName) return new Response(found.bytes)
      return Response.json({
        name,
        'dist-tags': { latest: found.version },
        versions: {
          [found.version]: {
            name,
            version: found.version,
            bin: found.bin,
            dist: {
              tarball: `${registryUrl}/tarballs/${encodeURIComponent(name)}`,
              integrity: `sha512-${createHash('sha512').update(found.bytes).digest('base64')}`,
              shasum: createHash('sha1').update(found.bytes).digest('hex'),
            },
          },
        },
      })
    },
  })
  const registryUrl = `http://host.docker.internal:${server.port}`
  return {
    url: registryUrl,
    requested,
    stop: () => {
      void server.stop(true)
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
