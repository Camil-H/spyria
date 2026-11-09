import { expect, test } from 'bun:test'
import {
  environmentOf,
  newInstallHostToken,
  parseEnvironment,
  type SetupAnswers,
  serializeEnvironment,
  setupLinkOf,
} from './environment.ts'
import { secretVariables } from './flags.ts'

const answers: SetupAnswers = {
  deployment: 'spyria',
  version: '1.2.0',
  images: 'ghcr.io/camil-h',
  origin: 'https://spyria.example.com',
  joinBy: 'invited-address',
  tunnelToken: 'tunnel-token',
  runsHost: true,
  dockerGroup: '999',
  instanceApps: {},
  localPort: 3300,
}

test('a first setup generates every secret, the install code and the settings of the answers', () => {
  const environment = environmentOf(answers)
  for (const name of [
    'SPYRIA_TOKEN_SECRET',
    'SPYRIA_SECRETS_KEY',
    'SPYRIA_SETUP_TOKEN',
    'SPYRIA_GATEWAY_ADMIN_PASSWORD',
    'SPYRIA_GATEWAY_ENCRYPTION_KEY',
    'SPYRIA_GATEWAY_SETUP_TOKEN',
    'SPYRIA_GATEWAY_DB_PASSWORD',
    'SPYRIA_POSTGRES_PASSWORD',
    'SPYRIA_ZERO_ADMIN_PASSWORD',
  ])
    expect(environment[name]).toMatch(/^[a-f0-9]{64}$/)
  expect(environment.SPYRIA_INSTALL_HOST_TOKEN).toMatch(/^[A-HJ-NP-Z2-9]{16}$/)
  expect(environment.SPYRIA_GATEWAY_ADMIN_USER).toMatch(/^admin-[a-f0-9]{8}$/)
  expect(environment).toMatchObject({
    SPYRIA_DEPLOYMENT: 'spyria',
    SPYRIA_VERSION: '1.2.0',
    SPYRIA_APP_ORIGIN: 'https://spyria.example.com',
    SPYRIA_JOIN_BY: 'invited-address',
    COMPOSE_PROFILES: 'host,cloudflare',
    SPYRIA_TRUSTED_PROXY: 'cloudflare',
    CLOUDFLARE_TUNNEL_TOKEN: 'tunnel-token',
    SPYRIA_HOST_CLAIM_URL: `http://server:3000/h/${environment.SPYRIA_INSTALL_HOST_TOKEN}`,
    SPYRIA_DOCKER_GROUP: '999',
  })
  expect(setupLinkOf(environment)).toBe(`https://spyria.example.com/?setup=${environment.SPYRIA_SETUP_TOKEN}`)
})

test('setting up again keeps every secret, so stored secrets and runtimes keep working', () => {
  const first = environmentOf(answers)
  const again = environmentOf({ ...answers, version: '1.3.0', runsHost: false, tunnelToken: undefined }, first)
  for (const name of Object.keys(first).filter(
    (key) =>
      /SECRET|KEY|TOKEN|PASSWORD|ADMIN_USER/.test(key) &&
      key !== 'CLOUDFLARE_TUNNEL_TOKEN' &&
      key !== 'SPYRIA_INSTALL_HOST_TOKEN',
  ))
    expect(again[name]).toBe(first[name])
  expect(again).toMatchObject({
    SPYRIA_VERSION: '1.3.0',
    COMPOSE_PROFILES: '',
    SPYRIA_HOST_CLAIM_URL: '',
    SPYRIA_INSTALL_HOST_TOKEN: '',
  })
})

test('the environment file round-trips, drops empty values and refuses a value spanning lines', () => {
  const environment = environmentOf({
    ...answers,
    smtp: { url: 'smtps://resend:key@smtp.resend.com:465', from: 'Spyria <spyria@example.com>' },
  })
  expect(parseEnvironment(serializeEnvironment(environment))).toEqual(
    Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== '')),
  )
  expect(parseEnvironment('# comment\nA=1\n\nB=x=y\n')).toEqual({ A: '1', B: 'x=y' })
  expect(parseEnvironment('A=\'p$ss word\'\nB="x"\n')).toEqual({ A: 'p$ss word', B: 'x' })
  expect(serializeEnvironment({ A: 'p$ss' })).toBe("A='p$ss'\n")
  expect(() => serializeEnvironment({ A: 'one\ntwo' })).toThrow('A cannot hold a quote or span lines')
  expect(() => serializeEnvironment({ A: "it's" })).toThrow('A cannot hold a quote or span lines')
})

test('answers are checked: a deployment name Docker accepts and an https address', () => {
  expect(() => environmentOf({ ...answers, deployment: 'Spyria Prod' })).toThrow('lowercase letters, digits and dashes')
  expect(() => environmentOf({ ...answers, origin: 'http://localhost' })).toThrow('must start with https://')
})

test('install codes use the claim code alphabet and differ', () => {
  const codes = new Set(Array.from({ length: 50 }, newInstallHostToken))
  expect(codes.size).toBe(50)
  for (const code of codes) expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{16}$/)
})

test("no secret setup reads from the environment is a setting it writes, so the install's own .env never answers for you", () => {
  const written = Object.keys(environmentOf({ ...answers, smtp: { url: 'smtps://x', from: 'Spyria <s@x>' } }))
  const everyInstanceApp = environmentOf({
    ...answers,
    instanceApps: { google: { clientId: 'g', clientSecret: 'g' }, microsoft: { clientId: 'm', clientSecret: 'm' } },
  })
  for (const variable of Object.values(secretVariables)) {
    expect(written).not.toContain(variable)
    expect(Object.keys(everyInstanceApp)).not.toContain(variable)
  }
})

test('without a runtime host on this machine, the server gets no install host token, so the first workspace gets no host that would never pair', () => {
  const withoutHost = environmentOf({ ...answers, runsHost: false })
  expect(withoutHost.SPYRIA_INSTALL_HOST_TOKEN).toBe('')
  expect(withoutHost.SPYRIA_HOST_CLAIM_URL).toBe('')
  expect(serializeEnvironment(withoutHost)).not.toContain('SPYRIA_INSTALL_HOST_TOKEN')
  const hostTurnedOn = environmentOf(answers, parseEnvironment(serializeEnvironment(withoutHost)))
  expect(hostTurnedOn.SPYRIA_INSTALL_HOST_TOKEN).toMatch(/^[A-HJ-NP-Z2-9]{16}$/)
  expect(hostTurnedOn.SPYRIA_HOST_CLAIM_URL).toBe(`http://server:3000/h/${hostTurnedOn.SPYRIA_INSTALL_HOST_TOKEN}`)
})
