import { type createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const fakeGitHubAppId = '4242'
export const fakeGitHubClientId = 'Iv1.fakeclient'
export const fakeGitHubClientSecret = 'fake-client-secret'
export const fakeGitHubLogin = 'alice-martin'
const installationId = 77
const accessLifetimeSeconds = 8 * 60 * 60

type Repository = { fullName: string; branches: string[]; files: Record<string, string> }
type IssuedToken = { token: string; repositories?: string[]; permissions?: Record<string, string> }

export const fakeGitHubRepositories: Repository[] = [
  {
    fullName: 'acme/app',
    branches: ['main', 'release'],
    files: {
      'README.md': '# acme app\n',
      'AGENTS.md': 'Run the tests before committing.\n',
      'only-in-acme-app.txt': 'This file only exists in acme/app.\n',
    },
  },
  {
    fullName: 'acme/docs',
    branches: ['main'],
    files: {
      'README.md': '# acme docs\n',
      '.hq/setup.sh': 'echo "installing the docs toolchain"\necho "docs-tool: command not found" >&2\nexit 127\n',
    },
  },
]

const git = (cwd: string, ...command: string[]) => {
  const result = Bun.spawnSync(['git', '-c', 'init.defaultBranch=main', ...command], { cwd, stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

const bareRepositoryOf = (root: string, { fullName, branches, files }: Repository) => {
  const source = join(root, 'sources', fullName)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(source, path, '..'), { recursive: true })
    writeFileSync(join(source, path), content)
  }
  git(source, 'init', '-q')
  git(source, 'add', '.')
  git(source, '-c', 'user.name=Fake', '-c', 'user.email=fake@example.com', 'commit', '-q', '-m', 'Initial commit')
  for (const branch of branches.filter((name) => name !== 'main')) git(source, 'branch', branch)
  git(root, 'clone', '-q', '--bare', source, `${fullName}.git`)
}

const jwtIssuerOf = (authorization: string | null, publicKey: ReturnType<typeof createPublicKey>) => {
  const [header = '', payload = '', signature = ''] = (authorization ?? '').replace(/^Bearer /, '').split('.')
  const isSigned = verify(
    'RSA-SHA256',
    Buffer.from(`${header}.${payload}`),
    publicKey,
    Buffer.from(signature, 'base64url'),
  )
  if (!isSigned) return undefined
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { iss?: string; exp?: number }
  return (claims.exp ?? 0) * 1000 > Date.now() ? claims.iss : undefined
}

const cgiResponseOf = (output: Buffer) => {
  const separator = output.indexOf('\r\n\r\n')
  const headerLines = output.subarray(0, separator).toString().split('\r\n')
  const headers = Object.fromEntries(headerLines.map((line) => line.split(/:\s*/, 2) as [string, string]))
  const status = Number((headers.Status ?? '200').split(' ')[0])
  delete headers.Status
  return new Response(new Uint8Array(output.subarray(separator + 4)), { status, headers })
}

export const startFakeGitHub = () => {
  const root = mkdtempSync(join(tmpdir(), 'hq-fake-github-'))
  for (const repository of fakeGitHubRepositories) bareRepositoryOf(root, repository)
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const appPrivateKey = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
  const installationTokens = new Map<string, IssuedToken>()
  const userTokens = new Map<string, number>()
  const refreshTokens = new Set<string>()
  const codes = new Set<string>()
  const gitAuthorizations: string[] = []
  const repositoryNamed = (fullName: string) => fakeGitHubRepositories.find((repo) => repo.fullName === fullName)
  const installationTokenOf = (request: Request) =>
    installationTokens.get((request.headers.get('authorization') ?? '').replace(/^(Bearer|token) /, ''))
  const userTokensIssued = () => {
    const accessToken = `ghu_${crypto.randomUUID()}`
    const refreshToken = `ghr_${crypto.randomUUID()}`
    userTokens.set(accessToken, Date.now() + accessLifetimeSeconds * 1000)
    refreshTokens.add(refreshToken)
    return Response.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: accessLifetimeSeconds,
      refresh_token_expires_in: 15_897_600,
      token_type: 'bearer',
      scope: '',
    })
  }
  const notFound = () => Response.json({ message: 'Not Found' }, { status: 404 })
  const unauthorized = () => Response.json({ message: 'Bad credentials' }, { status: 401 })

  const serveGit = async (request: Request, pathInfo: string) => {
    const [, basic = ''] = /^Basic (.+)$/.exec(request.headers.get('authorization') ?? '') ?? []
    const password = Buffer.from(basic, 'base64').toString().split(':')[1] ?? ''
    const fullName = pathInfo.split('.git/')[0]?.slice(1) ?? ''
    const issued = installationTokens.get(password)
    if (!issued || !(issued.repositories ?? [fullName]).includes(fullName.split('/')[1] ?? ''))
      return new Response('Authentication required', { status: 401, headers: { 'www-authenticate': 'Basic' } })
    gitAuthorizations.push(password)
    const url = new URL(request.url)
    const child = Bun.spawn(['git', 'http-backend'], {
      env: {
        PATH: process.env.PATH ?? '',
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: pathInfo,
        REQUEST_METHOD: request.method,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: request.headers.get('content-type') ?? '',
        HTTP_CONTENT_ENCODING: request.headers.get('content-encoding') ?? '',
        GIT_PROTOCOL: request.headers.get('git-protocol') ?? '',
      },
      stdin: request.method === 'POST' ? new Uint8Array(await request.arrayBuffer()) : 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    })
    return cgiResponseOf(Buffer.from(await new Response(child.stdout).arrayBuffer()))
  }

  const api = async (request: Request, path: string) => {
    const isApp = jwtIssuerOf(request.headers.get('authorization'), publicKey) === fakeGitHubAppId
    if (path === '/app') return isApp ? Response.json({ id: Number(fakeGitHubAppId), slug: 'hq-test' }) : unauthorized()
    if (path === '/app/installations')
      return isApp ? Response.json([{ id: installationId, account: { login: 'acme' } }]) : unauthorized()
    const repositoryInstallation = /^\/repos\/([\w.-]+\/[\w.-]+)\/installation$/.exec(path)
    if (repositoryInstallation)
      return !isApp
        ? unauthorized()
        : repositoryNamed(repositoryInstallation[1] ?? '')
          ? Response.json({ id: installationId })
          : notFound()
    if (path === `/app/installations/${installationId}/access_tokens` && request.method === 'POST') {
      if (!isApp) return unauthorized()
      const body = (await request.json().catch(() => ({}))) as Omit<IssuedToken, 'token'>
      const token = `ghs_${crypto.randomUUID()}`
      installationTokens.set(token, { token, ...body })
      return Response.json({ token, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 })
    }
    if (path === '/installation/repositories')
      return installationTokenOf(request)
        ? Response.json({
            total_count: fakeGitHubRepositories.length,
            repositories: fakeGitHubRepositories.map(({ fullName }) => ({
              full_name: fullName,
              default_branch: 'main',
              private: true,
            })),
          })
        : unauthorized()
    const branches = /^\/repos\/([\w.-]+\/[\w.-]+)\/branches$/.exec(path)
    if (branches) {
      if (!installationTokenOf(request)) return unauthorized()
      const repository = repositoryNamed(branches[1] ?? '')
      return repository ? Response.json(repository.branches.map((name) => ({ name }))) : notFound()
    }
    if (path === '/user') {
      const expiresAt = userTokens.get((request.headers.get('authorization') ?? '').replace(/^Bearer /, ''))
      return expiresAt && expiresAt > Date.now() ? Response.json({ login: fakeGitHubLogin }) : unauthorized()
    }
    return notFound()
  }

  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname.startsWith('/api/v3')) return api(request, url.pathname.slice('/api/v3'.length))
      if (url.pathname === '/login/oauth/authorize') {
        const code = `code-${crypto.randomUUID()}`
        codes.add(code)
        const redirect = new URL(url.searchParams.get('redirect_uri') ?? '')
        redirect.searchParams.set('code', code)
        redirect.searchParams.set('state', url.searchParams.get('state') ?? '')
        return url.searchParams.get('client_id') === fakeGitHubClientId
          ? Response.redirect(redirect.href, 302)
          : new Response('Unknown client', { status: 404 })
      }
      if (url.pathname === '/login/oauth/access_token' && request.method === 'POST') {
        const parameters = Object.fromEntries(new URLSearchParams(await request.text()))
        if (parameters.client_id !== fakeGitHubClientId || parameters.client_secret !== fakeGitHubClientSecret)
          return Response.json({ error: 'incorrect_client_credentials' })
        if (parameters.grant_type === 'refresh_token')
          return refreshTokens.delete(parameters.refresh_token ?? '')
            ? userTokensIssued()
            : Response.json({ error: 'bad_refresh_token' })
        return codes.delete(parameters.code ?? '')
          ? userTokensIssued()
          : Response.json({ error: 'bad_verification_code' })
      }
      if (/^\/[\w.-]+\/[\w.-]+\.git\//.test(url.pathname)) return serveGit(request, url.pathname)
      return notFound()
    },
  })
  const webUrl = `http://localhost:${server.port}`
  return {
    urls: { apiUrl: `${webUrl}/api/v3`, webUrl },
    appPrivateKey,
    installationTokens,
    gitAuthorizations,
    expireUserTokens: () => {
      for (const token of userTokens.keys()) userTokens.set(token, 0)
    },
    revokeRefreshTokens: () => refreshTokens.clear(),
    stop: async () => {
      await server.stop(true)
      rmSync(root, { recursive: true, force: true })
    },
  }
}

export type FakeGitHub = ReturnType<typeof startFakeGitHub>
