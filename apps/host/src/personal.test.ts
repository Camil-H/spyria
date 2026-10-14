import { expect, test } from 'bun:test'
import { type Docker, DockerError } from './docker.ts'
import { credentialsContainerBodyOf, credentialsReaderBodyOf, readCredentials, redacted } from './personal.ts'

const image = `sha256:${'a'.repeat(64)}`
const accessToken = 'sk-ant-oat01-FAKEACCESS-dummy-file-000000000000'
const refreshToken = 'sk-ant-ort01-FAKEREFRESH-dummy-file-0000000000'
const credentialsFile = JSON.stringify({
  claudeAiOauth: { accessToken, refreshToken, expiresAt: 4102444800000, subscriptionType: 'max' },
})

const fakeJwt = (claims: object) =>
  `${btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).replaceAll('=', '')}.${btoa(JSON.stringify(claims)).replaceAll('=', '')}.FAKESIGNATURE-dummy`
const codexTokens = {
  id_token: fakeJwt({ sub: 'auth0|FAKEUSER', email: 'dummy@example.invalid' }),
  access_token: fakeJwt({ sub: 'auth0|FAKEUSER', scp: ['openid'] }),
  refresh_token: 'rt_FAKEREFRESH-dummy-file-0000000000000000',
  account_id: 'FAKEACCOUNT-0000',
}
const codexAuthFile = JSON.stringify({ OPENAI_API_KEY: null, auth_mode: 'chatgpt', tokens: codexTokens })
const codexApiKey = 'sk-proj-FAKEKEY-dummy-file-000000000000'
const codexApiKeyFile = JSON.stringify({ OPENAI_API_KEY: codexApiKey, auth_mode: 'apikey' })

const tarOf = (content: string) => {
  const header = new Array(512).fill('\0')
  header.splice(0, 17, ...'.credentials.json')
  header.splice(124, 12, ...`${content.length.toString(8).padStart(11, '0')}\0`)
  return `${header.join('')}${content}${'\0'.repeat(1024)}`
}
const dockerWithArchive =
  (archive: string | undefined, codexArchive?: string): Docker =>
  async (_method, path) => {
    const found = path.startsWith('/containers/hq-cred-codex-reader/archive?path=/workspace/project/auth.json')
      ? codexArchive
      : path.startsWith('/containers/hq-cred-claude-reader/archive?path=/workspace/project/.credentials.json')
        ? archive
        : (() => {
            throw new Error(`unexpected ${path}`)
          })()
    if (found === undefined) throw new DockerError(404, 'Could not find the file')
    return found as never
  }

test('signedIn follows the presence of the credentials file and its token values are kept for redaction', async () => {
  expect(await readCredentials(dockerWithArchive(tarOf(credentialsFile)), 'hq-')).toEqual({
    signedIn: ['claude'],
    secrets: [accessToken, refreshToken],
  })
  expect(await readCredentials(dockerWithArchive(undefined), 'hq-')).toEqual({ signedIn: [], secrets: [] })
})

test('the token formats and the exact current token values are redacted, the rest of the frame stays valid JSON', async () => {
  const { secrets } = await readCredentials(dockerWithArchive(tarOf(credentialsFile)), 'hq-')
  const httpBody = JSON.stringify({
    output: `${credentialsFile}\nother sk-ant-oat01-Older_token-1 sk-ant-ort01-x`,
    ok: 1,
  })
  expect(JSON.parse(redacted(httpBody, ['custom-token-value-1', ...secrets]))).toEqual({
    output: `${JSON.stringify({
      claudeAiOauth: {
        accessToken: '[redacted]',
        refreshToken: '[redacted]',
        expiresAt: 4102444800000,
        subscriptionType: 'max',
      },
    })}\nother [redacted] [redacted]`,
    ok: 1,
  })
})

test('login runs the documented command in a one-off TTY container of the pinned image on the credentials volume, as uid 10001', () => {
  expect(credentialsContainerBodyOf('hq-', image, 'claude', 'login')).toEqual({
    Image: image,
    User: '10001:10001',
    Entrypoint: ['claude-agent-acp', '--cli', 'auth', 'login', '--claudeai'],
    Tty: true,
    OpenStdin: true,
    StdinOnce: true,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Labels: { 'hq.managed': '1' },
    HostConfig: {
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      ReadonlyRootfs: true,
      NetworkMode: 'bridge',
      AutoRemove: true,
      Tmpfs: { '/home/openhands': 'uid=10001,gid=10001,mode=0700', '/tmp': '' },
      Mounts: [{ Type: 'volume', Source: 'hq-cred-claude', Target: '/home/openhands/.claude' }],
    },
  })
})

test('logout deletes the credentials file without a network or a terminal', () => {
  expect(credentialsContainerBodyOf('hq-', image, 'claude', 'logout')).toMatchObject({
    User: '10001:10001',
    Entrypoint: ['rm', '-f', '/home/openhands/.claude/.credentials.json'],
    Tty: false,
    OpenStdin: false,
    HostConfig: { NetworkMode: 'none', Mounts: [{ Source: 'hq-cred-claude', Target: '/home/openhands/.claude' }] },
  })
})

test('the credentials reader is never started and mounts the volume where the image owns an empty directory', () => {
  expect(credentialsReaderBodyOf('hq-', image, 'claude')).toMatchObject({
    Image: image,
    User: '10001:10001',
    NetworkDisabled: true,
    HostConfig: { NetworkMode: 'none', Mounts: [{ Source: 'hq-cred-claude', Target: '/workspace/project' }] },
  })
})

test('signedIn includes codex only for a ChatGPT auth.json, and its token values and API key are kept for redaction', async () => {
  expect(await readCredentials(dockerWithArchive(undefined, tarOf(codexAuthFile)), 'hq-')).toEqual({
    signedIn: ['codex'],
    secrets: [codexTokens.id_token, codexTokens.access_token, codexTokens.refresh_token],
  })
  expect(await readCredentials(dockerWithArchive(tarOf(credentialsFile), tarOf(codexApiKeyFile)), 'hq-')).toEqual({
    signedIn: ['claude'],
    secrets: [accessToken, refreshToken, codexApiKey],
  })
})

test('a JWT, the exact Codex refresh token and the API key are redacted, the account id stays', async () => {
  const { secrets } = await readCredentials(dockerWithArchive(undefined, tarOf(codexAuthFile)), 'hq-')
  const frame = JSON.stringify({
    output: `${codexAuthFile}\nother ${fakeJwt({ sub: 'another' })} ${codexApiKey}`,
    ok: 1,
  })
  expect(JSON.parse(redacted(frame, [...secrets, codexApiKey]))).toEqual({
    output: `${JSON.stringify({
      OPENAI_API_KEY: null,
      auth_mode: 'chatgpt',
      tokens: {
        id_token: '[redacted]',
        access_token: '[redacted]',
        refresh_token: '[redacted]',
        account_id: 'FAKEACCOUNT-0000',
      },
    })}\nother [redacted] [redacted]`,
    ok: 1,
  })
})

test('login codex runs the device sign-in in a one-off TTY container on the Codex volume, as uid 10001', () => {
  expect(credentialsContainerBodyOf('hq-', image, 'codex', 'login')).toEqual({
    Image: image,
    User: '10001:10001',
    Entrypoint: ['codex-acp', 'cli', 'login', '--device-auth'],
    Tty: true,
    OpenStdin: true,
    StdinOnce: true,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Labels: { 'hq.managed': '1' },
    HostConfig: {
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      ReadonlyRootfs: true,
      NetworkMode: 'bridge',
      AutoRemove: true,
      Tmpfs: { '/home/openhands': 'uid=10001,gid=10001,mode=0700', '/tmp': '' },
      Mounts: [{ Type: 'volume', Source: 'hq-cred-codex', Target: '/home/openhands/.codex' }],
    },
  })
})

test('logout codex deletes auth.json without a network or a terminal', () => {
  expect(credentialsContainerBodyOf('hq-', image, 'codex', 'logout')).toMatchObject({
    User: '10001:10001',
    Entrypoint: ['rm', '-f', '/home/openhands/.codex/auth.json'],
    Tty: false,
    OpenStdin: false,
    HostConfig: { NetworkMode: 'none', Mounts: [{ Source: 'hq-cred-codex', Target: '/home/openhands/.codex' }] },
  })
})

test('the Codex reader mounts its volume where the image owns an empty directory', () => {
  expect(credentialsReaderBodyOf('hq-', image, 'codex')).toMatchObject({
    NetworkDisabled: true,
    HostConfig: { NetworkMode: 'none', Mounts: [{ Source: 'hq-cred-codex', Target: '/workspace/project' }] },
  })
})
