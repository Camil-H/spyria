import { expect, test } from 'bun:test'
import { readSecretFiles } from './secret-files.ts'

const readFile = () => 'https://spyria.example/h/CODE\n'

test('the claim URL and the telemetry headers are read from the files their _FILE settings name', () => {
  const environment: Record<string, string | undefined> = { SPYRIA_HOST_CLAIM_URL_FILE: '/run/secrets/claim-url' }
  readSecretFiles(environment, readFile)
  expect(environment).toEqual({ SPYRIA_HOST_CLAIM_URL: 'https://spyria.example/h/CODE' })
})

test('a secret set both in the environment and in a file is refused', () => {
  expect(() =>
    readSecretFiles(
      { OTEL_EXPORTER_OTLP_HEADERS: 'authorization=x', OTEL_EXPORTER_OTLP_HEADERS_FILE: '/run/secrets/otlp' },
      readFile,
    ),
  ).toThrow('Set OTEL_EXPORTER_OTLP_HEADERS or OTEL_EXPORTER_OTLP_HEADERS_FILE, not both')
})
