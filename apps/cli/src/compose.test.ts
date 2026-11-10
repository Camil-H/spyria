import { expect, test } from 'bun:test'
import { composeCommandOf, operatorCommandOf, shellEnvironmentOf } from './compose.ts'

test("Compose runs on the install folder's files, and settings in the shell never override the .env file", () => {
  expect(composeCommandOf('/home/pat/spyria', ['up', '-d'])).toEqual([
    'docker',
    'compose',
    '--env-file',
    '/home/pat/spyria/.env',
    '-f',
    '/home/pat/spyria/compose.yml',
    'up',
    '-d',
  ])
  expect(
    shellEnvironmentOf({
      PATH: '/bin',
      HOME: '/home/pat',
      SPYRIA_VERSION: '0.1.0',
      COMPOSE_PROFILES: 'host',
      OTEL_X: 'y',
      CLOUDFLARE_TUNNEL_TOKEN: 't',
      DOCKER_HOST: 'unix:///x',
    }),
  ).toEqual({ PATH: '/bin', HOME: '/home/pat', DOCKER_HOST: 'unix:///x' })
  expect(operatorCommandOf(['setup-link'])).toEqual([
    'exec',
    '-T',
    'server',
    'bun',
    'apps/server/src/operator-cli.ts',
    'setup-link',
  ])
})
