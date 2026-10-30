import { afterAll, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptySetupFiles, packageCacheEnvironmentOf, setupFilesOf, toolEnvironmentOf } from './tool-environment.ts'

const directory = mkdtempSync(join(tmpdir(), 'spyria-tool-environment-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const homeNamed = (name: string) => {
  const home = join(directory, name)
  mkdirSync(home, { recursive: true })
  return home
}
const wellKnown = (home: string) =>
  ['.local/bin', '.bun/bin', '.cargo/bin', '.deno/bin', 'go/bin', '.local/share/mise/shims'].map((path) =>
    join(home, path),
  )

test('without setup files, the well-known tool directories of the home come before the inherited PATH', () => {
  const home = homeNamed('plain')
  expect(toolEnvironmentOf({ PATH: '/usr/bin:/bin', LANG: 'C' }, home)).toEqual({
    PATH: [...wellKnown(home), '/usr/bin:/bin'].join(':'),
    HOME: home,
    LANG: 'C',
  })
})

test('directories the setup wrote to SPYRIA_PATH come first, the last line first; SPYRIA_ENV variables are added and may replace PATH', () => {
  const home = homeNamed('written')
  emptySetupFiles(home)
  const { SPYRIA_PATH, SPYRIA_ENV } = setupFilesOf(home)
  writeFileSync(SPYRIA_PATH, '/opt/first\n\n  /opt/second  \n')
  writeFileSync(SPYRIA_ENV, 'GREETING=hello = world\nPATH=/custom/bin\n=nameless\nnot a variable\n1BAD=x\nEMPTY=\n')
  expect(toolEnvironmentOf({ PATH: '/usr/bin' }, home)).toEqual({
    PATH: ['/opt/second', '/opt/first', ...wellKnown(home), '/custom/bin'].join(':'),
    HOME: home,
    GREETING: 'hello = world',
    EMPTY: '',
  })
})

test('emptying the setup files clears what an earlier setup wrote', () => {
  const home = homeNamed('emptied')
  emptySetupFiles(home)
  writeFileSync(setupFilesOf(home).SPYRIA_PATH, '/opt/stale\n')
  writeFileSync(setupFilesOf(home).SPYRIA_ENV, 'STALE=1\n')
  emptySetupFiles(home)
  expect(toolEnvironmentOf({ PATH: '/usr/bin' }, home)).toEqual({
    PATH: [...wellKnown(home), '/usr/bin'].join(':'),
    HOME: home,
  })
})

test('the package caches point into the cache directory only when it is writable', () => {
  const cache = homeNamed('cache')
  expect(packageCacheEnvironmentOf(cache)).toEqual({
    BUN_INSTALL_CACHE_DIR: join(cache, 'bun'),
    npm_config_cache: join(cache, 'npm'),
    npm_config_store_dir: join(cache, 'pnpm'),
    YARN_CACHE_FOLDER: join(cache, 'yarn'),
    UV_CACHE_DIR: join(cache, 'uv'),
    PIP_CACHE_DIR: join(cache, 'pip'),
    GOMODCACHE: join(cache, 'go'),
  })
  expect(packageCacheEnvironmentOf(join(directory, 'missing'))).toEqual({})
  const readOnly = homeNamed('read-only')
  chmodSync(readOnly, 0o500)
  expect(packageCacheEnvironmentOf(readOnly)).toEqual({})
})
