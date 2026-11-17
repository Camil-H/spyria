import { readFileSync } from 'node:fs'

const hostSecretNames = ['SPYRIA_HOST_CLAIM_URL', 'OTEL_EXPORTER_OTLP_HEADERS', 'HTTPS_PROXY', 'HTTP_PROXY']

const contentOf = (setting: string, path: string, readFile: (path: string) => string) => {
  try {
    return readFile(path).replace(/[\r\n]+$/, '')
  } catch (error) {
    throw new Error(`${setting} names ${path}, which cannot be read`, { cause: error })
  }
}

export const readSecretFiles = (
  environment: Record<string, string | undefined>,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
) => {
  for (const name of hostSecretNames) {
    const path = environment[`${name}_FILE`]
    if (!path) continue
    if (environment[name]) throw new Error(`Set ${name} or ${name}_FILE, not both`)
    environment[name] = contentOf(`${name}_FILE`, path, readFile)
    delete environment[`${name}_FILE`]
  }
}
