import { expect, test } from 'bun:test'
import {
  environmentOf,
  newInstallHostToken,
  pairingCodeOf,
  parseEnvironment,
  type SetupAnswers,
  serializeEnvironment,
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

test('an edited environment file reads its export prefixes and inline comments, and is rewritten keeping its comments, prefixes and order', () => {
  const edited = [
    '# Spyria settings',
    'export SPYRIA_DEPLOYMENT=spyria # the Compose project',
    "SPYRIA_SMTP_URL='smtps://user:p#ss@smtp.example.com:465' # mail",
    'SPYRIA_MAIL_FROM="Spyria <spyria@example.com>"',
    'SPYRIA_GOOGLE_CLIENT_ID=old.apps.googleusercontent.com',
    '',
    '# proxy of this network',
    'HTTPS_PROXY=http://proxy.internal:3128',
    '',
  ].join('\r\n')
  expect(parseEnvironment(edited)).toEqual({
    SPYRIA_DEPLOYMENT: 'spyria',
    SPYRIA_SMTP_URL: 'smtps://user:p#ss@smtp.example.com:465',
    SPYRIA_MAIL_FROM: 'Spyria <spyria@example.com>',
    SPYRIA_GOOGLE_CLIENT_ID: 'old.apps.googleusercontent.com',
    HTTPS_PROXY: 'http://proxy.internal:3128',
  })
  const rewritten = serializeEnvironment(
    {
      ...parseEnvironment(edited),
      SPYRIA_DEPLOYMENT: 'garage',
      SPYRIA_GOOGLE_CLIENT_ID: '',
      SPYRIA_VERSION: '1.3.0',
    },
    edited,
  )
  expect(rewritten).toBe(
    [
      '# Spyria settings',
      "export SPYRIA_DEPLOYMENT='garage' # the Compose project",
      "SPYRIA_SMTP_URL='smtps://user:p#ss@smtp.example.com:465' # mail",
      "SPYRIA_MAIL_FROM='Spyria <spyria@example.com>'",
      '',
      '# proxy of this network',
      "HTTPS_PROXY='http://proxy.internal:3128'",
      "SPYRIA_VERSION='1.3.0'",
      '',
    ].join('\n'),
  )
  expect(parseEnvironment(rewritten)).toEqual({
    SPYRIA_DEPLOYMENT: 'garage',
    SPYRIA_SMTP_URL: 'smtps://user:p#ss@smtp.example.com:465',
    SPYRIA_MAIL_FROM: 'Spyria <spyria@example.com>',
    HTTPS_PROXY: 'http://proxy.internal:3128',
    SPYRIA_VERSION: '1.3.0',
  })
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

test("the command of Add runtime host for this Spyria points this machine's host at its code instead of the install code and is kept while the host stays on, while a member's machine command or another Spyria's is refused", () => {
  const command =
    'docker rm -f spyria-host >/dev/null 2>&1; docker volume rm spyria-host >/dev/null 2>&1; docker run -d --name spyria-host --restart unless-stopped -e HTTPS_PROXY -e HTTP_PROXY -e NO_PROXY $(docker info -f \'{{.SecurityOptions}}\' | grep -q rootless && echo "--user 0 -v $XDG_RUNTIME_DIR/docker.sock:/var/run/docker.sock" || echo "--group-add $(test "$(uname)" = Darwin && echo 0 || stat -c %g /var/run/docker.sock) -v /var/run/docker.sock:/var/run/docker.sock") --cap-drop ALL --security-opt no-new-privileges --read-only -v spyria-host:/state ghcr.io/camil-h/spyria-host:1.2.0 https://spyria.example.com/h/ABCD2345'
  const origin = 'https://spyria.example.com'
  expect(pairingCodeOf(command, origin)).toBe('ABCD2345')
  expect(pairingCodeOf('https://spyria.example.com/h/WXYZ6789', origin)).toBe('WXYZ6789')
  expect(() => pairingCodeOf('https://spyria.example.com/', origin)).toThrow('not the command of Add runtime host')
  expect(() => pairingCodeOf(command.replace(' https://', ' --personal https://'), origin)).toThrow(
    "a member's own machine",
  )
  expect(() => pairingCodeOf(command, 'https://other.example.com')).toThrow(
    'This command pairs with https://spyria.example.com, not with https://other.example.com',
  )

  const withoutHost = environmentOf({ ...answers, runsHost: false })
  const paired = environmentOf({ ...answers, pairingCode: 'ABCD2345' }, withoutHost)
  expect(paired.SPYRIA_HOST_CLAIM_URL).toBe('http://server:3000/h/ABCD2345')
  expect(paired.SPYRIA_INSTALL_HOST_TOKEN).toBe('')
  const again = environmentOf(answers, parseEnvironment(serializeEnvironment(paired)))
  expect(again.SPYRIA_HOST_CLAIM_URL).toBe('http://server:3000/h/ABCD2345')
  expect(again.SPYRIA_INSTALL_HOST_TOKEN).toBe('')
  expect(environmentOf({ ...answers, runsHost: false }, again).SPYRIA_HOST_CLAIM_URL).toBe('')
})
