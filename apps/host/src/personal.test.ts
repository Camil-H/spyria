import { expect, test } from 'bun:test'
import { type Docker, DockerError } from './docker.ts'
import {
  credentialsContainerBodyOf,
  credentialsReaderBodyOf,
  loginCommand,
  logoutCommand,
  readCredentials,
  redacted,
} from './personal.ts'

const image = `ghcr.io/openhands/agent-server@sha256:${'a'.repeat(64)}`
const accessToken = 'sk-ant-oat01-FAKEACCESS-dummy-file-000000000000'
const refreshToken = 'sk-ant-ort01-FAKEREFRESH-dummy-file-0000000000'
const credentialsFile = JSON.stringify({
  claudeAiOauth: { accessToken, refreshToken, expiresAt: 4102444800000, subscriptionType: 'max' },
})

const tarOf = (content: string) => {
  const header = new Array(512).fill('\0')
  header.splice(0, 17, ...'.credentials.json')
  header.splice(124, 12, ...`${content.length.toString(8).padStart(11, '0')}\0`)
  return `${header.join('')}${content}${'\0'.repeat(1024)}`
}
const dockerWithArchive =
  (archive: string | undefined): Docker =>
  async (_method, path) => {
    if (!path.includes('/archive?path=/workspace/project/.credentials.json')) throw new Error(`unexpected ${path}`)
    if (archive === undefined) throw new DockerError(404, 'Could not find the file')
    return archive as never
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
  expect(credentialsContainerBodyOf('hq-', image, loginCommand)).toEqual({
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
  expect(credentialsContainerBodyOf('hq-', image, logoutCommand)).toMatchObject({
    User: '10001:10001',
    Entrypoint: ['rm', '-f', '/home/openhands/.claude/.credentials.json'],
    Tty: false,
    OpenStdin: false,
    HostConfig: { NetworkMode: 'none', Mounts: [{ Source: 'hq-cred-claude', Target: '/home/openhands/.claude' }] },
  })
})

test('the credentials reader is never started and mounts the volume where the image owns an empty directory', () => {
  expect(credentialsReaderBodyOf('hq-', image)).toMatchObject({
    Image: image,
    User: '10001:10001',
    NetworkDisabled: true,
    HostConfig: { NetworkMode: 'none', Mounts: [{ Source: 'hq-cred-claude', Target: '/workspace/project' }] },
  })
})
