import { type Docker, DockerError } from './docker.ts'

const conversationId = '[0-9a-f-]{32,36}'
const conversationPath = `/api/conversations/${conversationId}`
const allowedRequests = [
  /^GET \/ready$/,
  /^POST \/api\/conversations$/,
  new RegExp(`^(GET|DELETE) ${conversationPath}$`),
  new RegExp(`^POST ${conversationPath}/(events|interrupt|switch_llm)$`),
  new RegExp(`^GET ${conversationPath}/agent_final_response$`),
  new RegExp(`^WS /sockets/events/${conversationId}\\?resend_mode=(all|since&after_timestamp=[\\w%.:+-]+)$`),
]
const tokenFormat = /sk-ant-(?:oat|ort)[\w-]*/g
const tokenValue = /"(?:accessToken|refreshToken)"\s*:\s*"([^"]{8,})"/g
const credentialsTarget = '/home/openhands/.claude'
const readerTarget = '/workspace/project'
const readerNameOf = (prefix: string) => `${prefix}cred-claude-reader`
const hardening = { CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], ReadonlyRootfs: true }

export type Credentials = { signedIn: string[]; secrets: string[] }
export const loginCommand = ['claude-agent-acp', '--cli', 'auth', 'login', '--claudeai']
export const logoutCommand = ['rm', '-f', `${credentialsTarget}/.credentials.json`]

export const isAllowedOnPersonalHost = (method: string, path: string) =>
  allowedRequests.some((pattern) => pattern.test(`${method} ${path}`))

export const redacted = (text: string, secrets: readonly string[]) =>
  secrets.reduce((result, secret) => result.replaceAll(secret, '[redacted]'), text).replace(tokenFormat, '[redacted]')

export const credentialsMountOf = (prefix: string, target = credentialsTarget) => ({
  Type: 'volume',
  Source: `${prefix}cred-claude`,
  Target: target,
})

export const credentialsReaderBodyOf = (prefix: string, image: string) => ({
  Image: image,
  User: '10001:10001',
  NetworkDisabled: true,
  Labels: { 'hq.managed': '1' },
  HostConfig: { ...hardening, NetworkMode: 'none', Mounts: [credentialsMountOf(prefix, readerTarget)] },
})

export const credentialsContainerBodyOf = (prefix: string, image: string, command: string[]) => {
  const isLogin = command === loginCommand
  return {
    Image: image,
    User: '10001:10001',
    Entrypoint: command,
    Tty: isLogin,
    OpenStdin: isLogin,
    StdinOnce: isLogin,
    AttachStdin: isLogin,
    AttachStdout: true,
    AttachStderr: true,
    Labels: { 'hq.managed': '1' },
    HostConfig: {
      ...hardening,
      NetworkMode: isLogin ? 'bridge' : 'none',
      AutoRemove: isLogin,
      Tmpfs: { '/home/openhands': 'uid=10001,gid=10001,mode=0700', '/tmp': '' },
      Mounts: [credentialsMountOf(prefix)],
    },
  }
}

const isMissing = (error: unknown) => error instanceof DockerError && error.status === 404

export const ensureCredentialsReader = async (docker: Docker, prefix: string, image: string) => {
  const reader = await docker<{ Config?: { Image?: string } }>('GET', `/containers/${readerNameOf(prefix)}/json`).catch(
    (error) => {
      if (!isMissing(error)) throw error
    },
  )
  if (reader?.Config?.Image === image) return
  if (reader) await docker('DELETE', `/containers/${readerNameOf(prefix)}?force=true`)
  await docker('POST', `/containers/create?name=${readerNameOf(prefix)}`, credentialsReaderBodyOf(prefix, image)).catch(
    (error) => {
      if (!(error instanceof DockerError && error.status === 409)) throw error
    },
  )
}

export const readCredentials = async (docker: Docker, prefix: string): Promise<Credentials> => {
  const archive = await docker<string>(
    'GET',
    `/containers/${readerNameOf(prefix)}/archive?path=${readerTarget}/.credentials.json`,
  ).catch((error) => {
    if (!isMissing(error)) throw error
  })
  if (!archive) return { signedIn: [], secrets: [] }
  const content = archive.slice(512, 512 + Number.parseInt(archive.slice(124, 136), 8))
  return { signedIn: ['claude'], secrets: [...content.matchAll(tokenValue)].map((match) => match[1] ?? '') }
}

const attachTerminal = (socketPath: string, container: string) => {
  const attached = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<void>()
  let isUpgraded = false
  let header = Buffer.alloc(0)
  void Bun.connect({
    unix: socketPath,
    socket: {
      open: (socket) => {
        socket.write(
          `POST /containers/${container}/attach?stream=1&stdin=1&stdout=1&stderr=1 HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n`,
        )
      },
      data: (socket, chunk) => {
        if (isUpgraded) return void process.stdout.write(chunk)
        header = Buffer.concat([header, chunk])
        const headerEnd = header.indexOf('\r\n\r\n')
        if (headerEnd < 0) return
        if (!header.toString('latin1', 0, headerEnd).startsWith('HTTP/1.1 101'))
          return attached.reject(new Error(`Docker refused to attach: ${header.toString().split('\r\n')[0]}`))
        isUpgraded = true
        process.stdout.write(header.subarray(headerEnd + 4))
        process.stdin.setRawMode(true)
        process.stdin.on('data', (data) => socket.write(data))
        attached.resolve()
      },
      close: () => closed.resolve(),
      error: (_, error) => attached.reject(error),
    },
  }).catch(attached.reject)
  return attached.promise.then(() => ({ closed: closed.promise }))
}

export const runCredentialsCommand = async (
  docker: Docker,
  { socketPath, prefix, command }: { socketPath: string; prefix: string; command: string[] },
) => {
  const reader = await docker<{ Config: { Image: string } }>('GET', `/containers/${readerNameOf(prefix)}/json`).catch(
    (error) => {
      if (!isMissing(error)) throw error
      throw new Error('Start hq-host --personal and let it connect to HQ first: it learns the runtime image from HQ')
    },
  )
  const name = `${prefix}cred-claude-${command === loginCommand ? 'login' : 'logout'}`
  await docker('DELETE', `/containers/${name}?force=true`).catch((error) => {
    if (!isMissing(error)) throw error
  })
  await docker(
    'POST',
    `/containers/create?name=${name}`,
    credentialsContainerBodyOf(prefix, reader.Config.Image, command),
  )
  if (command !== loginCommand) {
    await docker('POST', `/containers/${name}/start`)
    await docker('POST', `/containers/${name}/wait`)
    return void (await docker('DELETE', `/containers/${name}`))
  }
  const terminal = await attachTerminal(socketPath, name)
  await docker('POST', `/containers/${name}/start`)
  await docker('POST', `/containers/${name}/resize?h=${process.stdout.rows}&w=${process.stdout.columns}`).catch(
    () => {},
  )
  await terminal.closed
  process.stdin.setRawMode(false)
  process.stdin.pause()
}
