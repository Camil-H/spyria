import { type Docker, DockerError } from './docker.ts'

const conversationId = '[0-9a-f-]{32,36}'
const conversationPath = `/api/conversations/${conversationId}`
const allowedRequests = [
  /^GET \/ready$/,
  /^POST \/api\/conversations$/,
  new RegExp(`^(GET|DELETE) ${conversationPath}$`),
  new RegExp(`^POST ${conversationPath}/(events|interrupt|switch_acp_model|plan_mode|questions/${conversationId})$`),
  new RegExp(`^WS /sockets/events/${conversationId}(\\?after=\\d+)?$`),
]
const tokenFormat = /sk-ant-(?:oat|ort)[\w-]*|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]+/g
const claudeTokenValue = /"(?:accessToken|refreshToken)"\s*:\s*"([^"]{8,})"/g
const minimumSecretLength = 8
const readerTarget = '/workspace/project'
const hardening = { CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], ReadonlyRootfs: true }

type SignIn = { signedIn: boolean; secrets: unknown[] }
const credentialStores = {
  claude: {
    target: '/home/openhands/.claude',
    file: '.credentials.json',
    login: ['claude-agent-acp', '--cli', 'auth', 'login', '--claudeai'],
    signInOf: (content: string): SignIn => ({
      signedIn: true,
      secrets: [...content.matchAll(claudeTokenValue)].map((match) => match[1]),
    }),
  },
  codex: {
    target: '/home/openhands/.codex',
    file: 'auth.json',
    login: ['codex-acp', 'cli', 'login', '--device-auth'],
    signInOf: (content: string): SignIn => {
      const { auth_mode, tokens, OPENAI_API_KEY } = JSON.parse(content)
      return {
        signedIn: auth_mode === 'chatgpt',
        secrets: [tokens?.id_token, tokens?.access_token, tokens?.refresh_token, OPENAI_API_KEY],
      }
    },
  },
}

export type CredentialsTool = keyof typeof credentialStores
export type CredentialsAction = 'login' | 'logout'
export type Credentials = { signedIn: string[]; secrets: string[] }
export const credentialsTools = Object.keys(credentialStores) as CredentialsTool[]
const readerNameOf = (prefix: string, tool: CredentialsTool) => `${prefix}cred-${tool}-reader`

export const isAllowedOnPersonalHost = (method: string, path: string) =>
  allowedRequests.some((pattern) => pattern.test(`${method} ${path}`))

export const redacted = (text: string, secrets: readonly string[]) =>
  secrets.reduce((result, secret) => result.replaceAll(secret, '[redacted]'), text).replace(tokenFormat, '[redacted]')

export const credentialsMountOf = (prefix: string, tool: CredentialsTool, target = credentialStores[tool].target) => ({
  Type: 'volume',
  Source: `${prefix}cred-${tool}`,
  Target: target,
})

export const credentialsMountsOf = (prefix: string) => credentialsTools.map((tool) => credentialsMountOf(prefix, tool))

export const credentialsReaderBodyOf = (prefix: string, image: string, tool: CredentialsTool) => ({
  Image: image,
  User: '10001:10001',
  NetworkDisabled: true,
  Labels: { 'hq.managed': '1' },
  HostConfig: { ...hardening, NetworkMode: 'none', Mounts: [credentialsMountOf(prefix, tool, readerTarget)] },
})

const credentialsCommandOf = (tool: CredentialsTool, action: CredentialsAction) => {
  const { login, target, file } = credentialStores[tool]
  return action === 'login' ? login : ['rm', '-f', `${target}/${file}`]
}

export const credentialsContainerBodyOf = (
  prefix: string,
  image: string,
  tool: CredentialsTool,
  action: CredentialsAction,
) => {
  const isLogin = action === 'login'
  return {
    Image: image,
    User: '10001:10001',
    Entrypoint: credentialsCommandOf(tool, action),
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
      Mounts: [credentialsMountOf(prefix, tool)],
    },
  }
}

const isMissing = (error: unknown) => error instanceof DockerError && error.status === 404

const ensureCredentialsReader = async (docker: Docker, prefix: string, image: string, tool: CredentialsTool) => {
  const name = readerNameOf(prefix, tool)
  const reader = await docker<{ Config?: { Image?: string } }>('GET', `/containers/${name}/json`).catch((error) => {
    if (!isMissing(error)) throw error
  })
  if (reader?.Config?.Image === image) return
  if (reader) await docker('DELETE', `/containers/${name}?force=true`)
  await docker('POST', `/containers/create?name=${name}`, credentialsReaderBodyOf(prefix, image, tool)).catch(
    (error) => {
      if (!(error instanceof DockerError && error.status === 409)) throw error
    },
  )
}

export const ensureCredentialsReaders = async (docker: Docker, prefix: string, image: string) => {
  for (const tool of credentialsTools) await ensureCredentialsReader(docker, prefix, image, tool)
}

const readSignIn = async (docker: Docker, prefix: string, tool: CredentialsTool) => {
  const { file, signInOf } = credentialStores[tool]
  const archive = await docker<string>(
    'GET',
    `/containers/${readerNameOf(prefix, tool)}/archive?path=${readerTarget}/${file}`,
  ).catch((error) => {
    if (!isMissing(error)) throw error
  })
  return archive ? signInOf(archive.slice(512, 512 + Number.parseInt(archive.slice(124, 136), 8))) : undefined
}

export const readCredentials = async (docker: Docker, prefix: string): Promise<Credentials> => {
  const signIns = await Promise.all(credentialsTools.map((tool) => readSignIn(docker, prefix, tool)))
  return {
    signedIn: credentialsTools.filter((_, index) => signIns[index]?.signedIn),
    secrets: signIns
      .flatMap((signIn) => signIn?.secrets ?? [])
      .filter((secret): secret is string => typeof secret === 'string' && secret.length >= minimumSecretLength),
  }
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

const readerWaitMilliseconds = 15 * 60 * 1000
const readerPollMilliseconds = 2000

const readerOnceConnected = async (docker: Docker, readerName: string) => {
  const deadline = Date.now() + readerWaitMilliseconds
  for (let attempt = 0; ; attempt++) {
    const reader = await docker<{ Config: { Image: string } }>('GET', `/containers/${readerName}/json`).catch(
      (error) => {
        if (!isMissing(error)) throw error
      },
    )
    if (reader) return reader
    if (Date.now() > deadline) throw new Error('hq-host did not connect to HQ: check its logs with docker logs hq-host')
    if (attempt === 0) console.log('Waiting for hq-host to connect to HQ…')
    await Bun.sleep(readerPollMilliseconds)
  }
}

export const runCredentialsCommand = async (
  docker: Docker,
  {
    socketPath,
    prefix,
    tool,
    action,
  }: { socketPath: string; prefix: string; tool: CredentialsTool; action: CredentialsAction },
) => {
  const reader = await readerOnceConnected(docker, readerNameOf(prefix, tool))
  const name = `${prefix}cred-${tool}-${action}`
  await docker('DELETE', `/containers/${name}?force=true`).catch((error) => {
    if (!isMissing(error)) throw error
  })
  await docker(
    'POST',
    `/containers/create?name=${name}`,
    credentialsContainerBodyOf(prefix, reader.Config.Image, tool, action),
  )
  if (action === 'logout') {
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
