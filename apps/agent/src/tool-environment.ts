import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type Environment = Record<string, string>

const toolDirectories = ['.local/bin', '.bun/bin', '.cargo/bin', '.deno/bin', 'go/bin', '.local/share/mise/shims']
const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/
const packageCacheDirectories = {
  BUN_INSTALL_CACHE_DIR: 'bun',
  npm_config_cache: 'npm',
  npm_config_store_dir: 'pnpm',
  YARN_CACHE_FOLDER: 'yarn',
  UV_CACHE_DIR: 'uv',
  PIP_CACHE_DIR: 'pip',
  GOMODCACHE: 'go',
}

export const setupFilesOf = (home: string) => ({
  SPYRIA_PATH: join(home, '.spyria', 'path'),
  SPYRIA_ENV: join(home, '.spyria', 'env'),
})

export const emptySetupFiles = (home: string) => {
  mkdirSync(join(home, '.spyria'), { recursive: true })
  for (const file of Object.values(setupFilesOf(home))) writeFileSync(file, '')
}

const linesOf = (file: string) => {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

const variablesOf = (lines: string[]) =>
  Object.fromEntries(
    lines.flatMap((line) => {
      const separator = line.indexOf('=')
      const name = line.slice(0, separator)
      return separator > 0 && variableName.test(name) ? [[name, line.slice(separator + 1)]] : []
    }),
  )

export const toolEnvironmentOf = (base: Environment, home: string): Environment => {
  const files = setupFilesOf(home)
  const variables = variablesOf(linesOf(files.SPYRIA_ENV))
  const path = [
    ...linesOf(files.SPYRIA_PATH).reverse(),
    ...toolDirectories.map((directory) => join(home, directory)),
    variables.PATH ?? base.PATH,
  ]
  return { ...base, HOME: home, ...variables, PATH: path.filter(Boolean).join(':') }
}

const isWritable = (directory: string) => {
  try {
    accessSync(directory, constants.W_OK)
    return true
  } catch {
    return false
  }
}

export const packageCacheEnvironmentOf = (directory: string): Environment =>
  isWritable(directory)
    ? Object.fromEntries(
        Object.entries(packageCacheDirectories).map(([name, folder]) => [name, join(directory, folder)]),
      )
    : {}
