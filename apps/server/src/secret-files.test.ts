import { expect, test } from 'bun:test'
import { readSecretFiles } from './secret-files.ts'

const files: Record<string, string> = {
  '/run/secrets/token-secret': 'from-file\n',
  '/run/secrets/secrets-key': 'key\r\n',
}
const readFile = (path: string) => {
  const content = files[path]
  if (content === undefined) throw new Error(`${path} does not exist`)
  return content
}

test('a secret named by its _FILE setting is read from that file without its trailing newline', () => {
  const environment: Record<string, string | undefined> = {
    SPYRIA_TOKEN_SECRET_FILE: '/run/secrets/token-secret',
    SPYRIA_SECRETS_KEY_FILE: '/run/secrets/secrets-key',
    SPYRIA_APP_ORIGIN: 'https://spyria.example',
  }
  readSecretFiles(environment, readFile)
  expect(environment).toEqual({
    SPYRIA_TOKEN_SECRET: 'from-file',
    SPYRIA_SECRETS_KEY: 'key',
    SPYRIA_APP_ORIGIN: 'https://spyria.example',
  })
})

test('a secret set in the environment is kept, and an empty value counts as unset', () => {
  const environment: Record<string, string | undefined> = {
    SPYRIA_TOKEN_SECRET: '',
    SPYRIA_SECRETS_KEY: 'from-environment',
  }
  readSecretFiles(environment, readFile)
  expect(environment).toEqual({ SPYRIA_TOKEN_SECRET: '', SPYRIA_SECRETS_KEY: 'from-environment' })
  environment.SPYRIA_TOKEN_SECRET_FILE = '/run/secrets/token-secret'
  readSecretFiles(environment, readFile)
  expect(environment.SPYRIA_TOKEN_SECRET).toBe('from-file')
})

test('a secret set both in the environment and in a file is refused, naming both settings', () => {
  expect(() =>
    readSecretFiles(
      { SPYRIA_TOKEN_SECRET: 'from-environment', SPYRIA_TOKEN_SECRET_FILE: '/run/secrets/token-secret' },
      readFile,
    ),
  ).toThrow('Set SPYRIA_TOKEN_SECRET or SPYRIA_TOKEN_SECRET_FILE, not both')
})

test('a _FILE setting of a name outside the secrets is left alone', () => {
  const environment: Record<string, string | undefined> = { SSL_CERT_FILE: '/etc/ssl/cert.pem' }
  readSecretFiles(environment, readFile)
  expect(environment).toEqual({ SSL_CERT_FILE: '/etc/ssl/cert.pem' })
})

test('a file that cannot be read stops the start, naming its setting', () => {
  expect(() => readSecretFiles({ SPYRIA_TOKEN_SECRET_FILE: '/run/secrets/missing' }, readFile)).toThrow(
    'SPYRIA_TOKEN_SECRET_FILE names /run/secrets/missing, which cannot be read',
  )
})
