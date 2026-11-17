import { readFileSync } from 'node:fs'

const serverSecretNames = [
  'DATABASE_URL',
  'SPYRIA_TOKEN_SECRET',
  'SPYRIA_SECRETS_KEY',
  'SPYRIA_PREVIOUS_SECRETS_KEYS',
  'SPYRIA_SETUP_TOKEN',
  'SPYRIA_INSTALL_HOST_TOKEN',
  'SPYRIA_GOOGLE_CLIENT_SECRET',
  'SPYRIA_MICROSOFT_CLIENT_SECRET',
  'SPYRIA_OIDC_CLIENT_SECRET',
  'SPYRIA_GATEWAY_ADMIN_PASSWORD',
  'OTEL_EXPORTER_OTLP_HEADERS',
]

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
  for (const name of serverSecretNames) {
    const path = environment[`${name}_FILE`]
    if (!path) continue
    if (environment[name]) throw new Error(`Set ${name} or ${name}_FILE, not both`)
    environment[name] = contentOf(`${name}_FILE`, path, readFile)
    delete environment[`${name}_FILE`]
  }
}

readSecretFiles(process.env)
