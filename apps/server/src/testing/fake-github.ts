import { type createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const fakeGitHubAppId = '4242'
export const fakeGitHubClientId = 'Iv1.fakeclient'
export const fakeGitHubClientSecret = 'fake-client-secret'
export const fakeGitHubLogin = 'alice-martin'
export const fakeGitHubUserId = 1001
export const fakeGitHubName = 'Alice Martin'
export const fakeGitHubAppSlug = 'spyria-test'
const installationId = 77
const accessLifetimeSeconds = 8 * 60 * 60
const grantedAppPermissions: Permissions = {
  contents: 'write',
  pull_requests: 'write',
  issues: 'read',
  checks: 'read',
  metadata: 'read',
  workflows: 'write',
}
const levels: Record<string, number> = { read: 1, write: 2 }

type Repository = { fullName: string; branches: string[]; files: Record<string, string> }
type AppManifest = { name: string; redirect_url: string; setup_url: string } & Record<string, unknown>
export type FakeAppCreation = { owner: string; manifest: AppManifest; webhookSecret?: string }
type Permissions = Record<string, string>
type IssuedToken = { token: string; repositories?: string[]; permissions: Permissions }
export type FakePullRequest = {
  repository: string
  number: number
  title: string
  body: string
  head: string
  base: string
  authorToken: string
}
type FakeComment = { author: string; body: string }
export type FakeIssue = {
  repository: string
  number: number
  title: string
  body: string
  state: 'open' | 'closed'
  author: string
  labels: string[]
  comments: FakeComment[]
  updatedAt: string
}
export type FakeReviewThread = {
  repository: string
  pullRequest: number
  path: string
  line: number | null
  isResolved: boolean
  isOutdated: boolean
  comments: FakeComment[]
}

export const fakeGitHubRepositories: Repository[] = [
  {
    fullName: 'acme/app',
    branches: ['main', 'release'],
    files: {
      'README.md': '# acme app\n',
      'AGENTS.md': 'Run the tests before committing.\n',
      'only-in-acme-app.txt': 'This file only exists in acme/app.\n',
      'src/app.ts': 'export const total = 1\n',
    },
  },
  {
    fullName: 'acme/docs',
    branches: ['main'],
    files: {
      'README.md': '# acme docs\n',
      '.spyria/setup.sh':
        'echo "installing the docs toolchain"\nsleep 3\necho "docs-tool: command not found" >&2\nexit 127\n',
    },
  },
]

const git = (cwd: string, ...command: string[]) => {
  const result = Bun.spawnSync(['git', '-c', 'init.defaultBranch=main', ...command], { cwd, stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
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

const allows = (granted: Permissions, permission: string, level: 'read' | 'write') =>
  (levels[granted[permission] ?? ''] ?? 0) >= (levels[level] ?? 0)

const cgiResponseOf = (output: Buffer) => {
  const separator = output.indexOf('\r\n\r\n')
  const headerLines = output.subarray(0, separator).toString().split('\r\n')
  const headers = Object.fromEntries(headerLines.map((line) => line.split(/:\s*/, 2) as [string, string]))
  const status = Number((headers.Status ?? '200').split(' ')[0])
  delete headers.Status
  return new Response(new Uint8Array(output.subarray(separator + 4)), { status, headers })
}

export const startFakeGitHub = () => {
  const root = mkdtempSync(join(tmpdir(), 'spyria-fake-github-'))
  for (const repository of fakeGitHubRepositories) bareRepositoryOf(root, repository)
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const appPrivateKey = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
  const installationTokens = new Map<string, IssuedToken>()
  let installationPermissions = grantedAppPermissions
  const userTokens = new Map<string, number>()
  const refreshTokens = new Set<string>()
  const codes = new Set<string>()
  const gitAuthorizations: string[] = []
  const apiRequests: string[] = []
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
  const pullRequests: FakePullRequest[] = []
  const issues: FakeIssue[] = []
  const reviewThreads: FakeReviewThread[] = []
  const searches: string[] = []
  const appCreations: FakeAppCreation[] = []
  const manifestCodes = new Map<string, FakeAppCreation>()
  const htmlPage = (body: string) =>
    new Response(`<!doctype html><meta charset="utf-8"><title>Fake GitHub</title>${body}`, {
      headers: { 'content-type': 'text/html' },
    })
  const escaped = (text: string) => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
  const continueButton = (target: string, label: string, parameters: Record<string, string>) =>
    `<form method="get" action="${escaped(target)}">${Object.entries(parameters)
      .map(([name, value]) => `<input type="hidden" name="${name}" value="${escaped(value)}">`)
      .join('')}<button>${label}</button></form>`
  const newAppPage = async (request: Request, owner: string) => {
    const manifest = JSON.parse(String((await request.formData()).get('manifest') ?? '{}')) as AppManifest
    const creation = { owner, manifest }
    const code = `manifest-${crypto.randomUUID()}`
    appCreations.push(creation)
    manifestCodes.set(code, creation)
    return htmlPage(
      `<h1>Create GitHub App for ${escaped(owner)}</h1><pre>${escaped(JSON.stringify(manifest))}</pre>${continueButton(manifest.redirect_url, 'Create GitHub App', { code, state: new URL(request.url).searchParams.get('state') ?? '' })}`,
    )
  }
  const bareOf = (repository: string) => join(root, `${repository}.git`)
  const branchHeadOf = (repository: string, branch: string) => {
    try {
      return git(bareOf(repository), 'rev-parse', '--verify', `refs/heads/${branch}`)
    } catch {
      return ''
    }
  }
  const branchNamesOf = ({ fullName, branches }: Repository) => [
    ...branches,
    ...git(bareOf(fullName), 'for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads/e2e-base-*')
      .split('\n')
      .filter(Boolean),
  ]
  const commitToBranch = (
    repository: string,
    {
      branch,
      from = 'main',
      files,
      message,
    }: { branch: string; from?: string; files: Record<string, string>; message: string },
  ) => {
    const source = mkdtempSync(join(root, 'commit-'))
    try {
      git(root, 'clone', '-q', '--branch', branchHeadOf(repository, branch) ? branch : from, bareOf(repository), source)
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(source, path, '..'), { recursive: true })
        writeFileSync(join(source, path), content)
      }
      git(source, 'add', '.')
      git(source, '-c', 'user.name=Rita', '-c', 'user.email=rita@example.com', 'commit', '-q', '-m', message)
      git(source, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`)
      return branchHeadOf(repository, branch)
    } finally {
      rmSync(source, { recursive: true, force: true })
    }
  }
  const commitSubjectsOf = (repository: string, branch: string, base = 'main') =>
    branchHeadOf(repository, branch)
      ? git(bareOf(repository), 'log', '--format=%s', `${base}..refs/heads/${branch}`).split('\n').filter(Boolean)
      : []
  const pullRequestJsonOf = (origin: string, { repository, number, title, head, base }: FakePullRequest) => ({
    number,
    html_url: `${origin}/${repository}/pull/${number}`,
    title,
    state: 'open',
    draft: false,
    merged: false,
    head: { sha: branchHeadOf(repository, head), ref: head },
    commits: commitSubjectsOf(repository, head, base).length,
  })
  const fakeCommentJsonOf = ({ author, body }: FakeComment) => ({ user: { login: author }, body })
  const issueJsonOf = (origin: string, issue: FakeIssue) => ({
    number: issue.number,
    html_url: `${origin}/${issue.repository}/issues/${issue.number}`,
    title: issue.title,
    state: issue.state,
    body: issue.body,
    user: { login: issue.author },
    labels: issue.labels.map((name) => ({ name })),
    comments: issue.comments.length,
    updated_at: issue.updatedAt,
  })
  const notFound = () => Response.json({ message: 'Not Found' }, { status: 404 })
  const notAccessible = () => Response.json({ message: 'Resource not accessible by integration' }, { status: 403 })
  const installationTokenAllows = (
    request: Request,
    repository: string,
    permission: string,
    level: 'read' | 'write',
  ) => {
    const issued = installationTokenOf(request)
    if (!issued) return unauthorized()
    if (issued.repositories && !issued.repositories.includes(repository.split('/')[1] ?? '')) return notFound()
    return allows(issued.permissions, permission, level) ? undefined : notAccessible()
  }
  const unauthorized = () => Response.json({ message: 'Bad credentials' }, { status: 401 })

  const isUserToken = (token: string) => (userTokens.get(token) ?? 0) > Date.now()
  const bearerOf = (request: Request) => (request.headers.get('authorization') ?? '').replace(/^(Bearer|token) /, '')
  const serveGit = async (request: Request, pathInfo: string) => {
    const [, basic = ''] = /^Basic (.+)$/.exec(request.headers.get('authorization') ?? '') ?? []
    const password = Buffer.from(basic, 'base64').toString().split(':')[1] ?? ''
    const fullName = pathInfo.split('.git/')[0]?.slice(1) ?? ''
    const issued = installationTokens.get(password)
    const isPush = pathInfo.endsWith('/git-receive-pack') || request.url.includes('service=git-receive-pack')
    const isAllowed = isPush
      ? isUserToken(password)
      : isUserToken(password) || (issued && (issued.repositories ?? [fullName]).includes(fullName.split('/')[1] ?? ''))
    if (!isAllowed || !repositoryNamed(fullName))
      return new Response('Authentication required', { status: 401, headers: { 'www-authenticate': 'Basic' } })
    const granted = issued?.permissions ?? installationPermissions
    if (!allows(granted, 'contents', isPush ? 'write' : 'read'))
      return new Response('Write access to repository not granted.', { status: 403 })
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
        REMOTE_USER: fakeGitHubLogin,
      },
      stdin: request.method === 'POST' ? new Uint8Array(await request.arrayBuffer()) : 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    })
    return cgiResponseOf(Buffer.from(await new Response(child.stdout).arrayBuffer()))
  }

  const api = async (request: Request, path: string) => {
    apiRequests.push(`${request.method} ${path}`)
    const conversion = /^\/app-manifests\/([\w-]+)\/conversions$/.exec(path)
    if (conversion && request.method === 'POST') {
      const creation = manifestCodes.get(conversion[1] ?? '')
      if (!creation) return notFound()
      manifestCodes.delete(conversion[1] ?? '')
      creation.webhookSecret = `whsec-${crypto.randomUUID()}`
      return Response.json(
        {
          id: Number(fakeGitHubAppId),
          slug: fakeGitHubAppSlug,
          name: creation.manifest.name,
          owner: { login: creation.owner },
          client_id: fakeGitHubClientId,
          client_secret: fakeGitHubClientSecret,
          webhook_secret: creation.webhookSecret,
          pem: appPrivateKey,
        },
        { status: 201 },
      )
    }
    const isApp = jwtIssuerOf(request.headers.get('authorization'), publicKey) === fakeGitHubAppId
    if (path === '/app')
      return isApp ? Response.json({ id: Number(fakeGitHubAppId), slug: 'spyria-test' }) : unauthorized()
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
      const { repositories, permissions = installationPermissions } = (await request.json().catch(() => ({}))) as {
        repositories?: string[]
        permissions?: Permissions
      }
      if (
        Object.entries(permissions).some(
          ([permission, level]) => !allows(installationPermissions, permission, level as 'read'),
        )
      )
        return Response.json(
          { message: 'The permissions requested are not granted to this installation.' },
          { status: 422 },
        )
      const token = `ghs_${crypto.randomUUID()}`
      installationTokens.set(token, { token, repositories, permissions: { ...permissions, metadata: 'read' } })
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
      const refused = installationTokenAllows(request, branches[1] ?? '', 'contents', 'read')
      if (refused) return refused
      const repository = repositoryNamed(branches[1] ?? '')
      return repository ? Response.json(branchNamesOf(repository).map((name) => ({ name }))) : notFound()
    }
    const pulls = /^\/repos\/([\w.-]+\/[\w.-]+)\/pulls(?:\/(\d+))?$/.exec(path)
    if (pulls) {
      const [, repository = '', number] = pulls
      const token = bearerOf(request)
      if (!isUserToken(token)) return unauthorized()
      if (!repositoryNamed(repository)) return notFound()
      if (!allows(installationPermissions, 'pull_requests', request.method === 'GET' ? 'read' : 'write'))
        return notAccessible()
      if (request.method === 'POST') {
        const { title = '', body = '', head = '', base = '' } = (await request.json()) as Record<string, string>
        if (!branchHeadOf(repository, head)) return Response.json({ message: 'Validation Failed' }, { status: 422 })
        const ownPullRequests = pullRequests.filter(
          (known) => known.repository === repository && known.authorToken === token,
        )
        pullRequests.push({
          repository,
          title,
          body,
          head,
          base,
          authorToken: token,
          number: ownPullRequests.length + 1,
        })
      }
      const pullRequest = pullRequests.findLast(
        (known) =>
          known.repository === repository &&
          known.authorToken === token &&
          (number === undefined || known.number === Number(number)),
      )
      if (pullRequest && request.method === 'PATCH') {
        const { title, body } = (await request.json()) as { title?: string; body?: string }
        if (title !== undefined) pullRequest.title = title
        if (body !== undefined) pullRequest.body = body
      }
      return pullRequest
        ? Response.json(pullRequestJsonOf(new URL(request.url).origin, pullRequest), {
            status: request.method === 'POST' ? 201 : 200,
          })
        : notFound()
    }
    const issueRead = /^\/repos\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)(\/comments)?$/.exec(path)
    if (issueRead) {
      const [, repository = '', number, isComments] = issueRead
      const refused = installationTokenAllows(request, repository, 'issues', 'read')
      if (refused) return refused
      const issue = issues.find((known) => known.repository === repository && known.number === Number(number))
      if (!issue) return notFound()
      return Response.json(
        isComments ? issue.comments.map(fakeCommentJsonOf) : issueJsonOf(new URL(request.url).origin, issue),
      )
    }
    if (path === '/search/issues') {
      const query = new URL(request.url).searchParams.get('q') ?? ''
      searches.push(query)
      const [, repository = ''] = /(?:^| )repo:(\S+)/.exec(query) ?? []
      const refused = installationTokenAllows(request, repository, 'issues', 'read')
      if (refused) return refused
      const [, state] = /(?:^| )state:(\w+)/.exec(query) ?? []
      const labels = [...query.matchAll(/label:"([^"]*)"/g)].map(([, label]) => label)
      const words = query
        .replace(/(?:^| )(?:repo|is|state):\S+|label:"[^"]*"/g, '')
        .trim()
        .toLowerCase()
      const items = issues
        .filter(
          (issue) =>
            issue.repository === repository &&
            (!state || issue.state === state) &&
            labels.every((label) => issue.labels.includes(label ?? '')) &&
            `${issue.title} ${issue.body}`.toLowerCase().includes(words),
        )
        .toSorted((first, second) => second.updatedAt.localeCompare(first.updatedAt))
      return Response.json({
        total_count: items.length,
        items: items.map((issue) => issueJsonOf(new URL(request.url).origin, issue)),
      })
    }
    if (path === '/user') {
      const expiresAt = userTokens.get((request.headers.get('authorization') ?? '').replace(/^Bearer /, ''))
      return expiresAt && expiresAt > Date.now()
        ? Response.json({ login: fakeGitHubLogin, id: fakeGitHubUserId, name: fakeGitHubName, email: null })
        : unauthorized()
    }
    return notFound()
  }

  const graphql = async (request: Request) => {
    const { variables } = (await request.json()) as { variables: { owner: string; name: string; number: number } }
    const repository = `${variables.owner}/${variables.name}`
    const refused = installationTokenAllows(request, repository, 'pull_requests', 'read')
    if (refused) return refused
    if (!pullRequests.some((known) => known.repository === repository && known.number === variables.number))
      return Response.json({
        data: { repository: { pullRequest: null } },
        errors: [
          { type: 'NOT_FOUND', message: `Could not resolve to a PullRequest with the number of ${variables.number}.` },
        ],
      })
    const nodes = reviewThreads
      .filter((thread) => thread.repository === repository && thread.pullRequest === variables.number)
      .map(({ path, line, isResolved, isOutdated, comments }) => ({
        path,
        line: isOutdated ? null : line,
        originalLine: line,
        isResolved,
        isOutdated,
        comments: { nodes: comments.map(({ author, body }) => ({ author: { login: author }, body })) },
      }))
    return Response.json({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } })
  }

  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname === '/api/graphql' && request.method === 'POST') return graphql(request)
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
      const newApp = /^(?:\/organizations\/([\w-]+))?\/settings\/apps\/new$/.exec(url.pathname)
      if (newApp && request.method === 'POST') return newAppPage(request, newApp[1] ?? fakeGitHubLogin)
      const created = appCreations.findLast((creation) => creation.webhookSecret)
      if (url.pathname === `/apps/${fakeGitHubAppSlug}/installations/new` && created)
        return htmlPage(
          `<h1>Install ${escaped(created.manifest.name)}</h1>${continueButton(created.manifest.setup_url, 'Install', { installation_id: String(installationId), setup_action: 'install' })}`,
        )
      return notFound()
    },
  })
  const webUrl = `http://localhost:${server.port}`
  return {
    urls: { apiUrl: `${webUrl}/api/v3`, webUrl },
    appPrivateKey,
    installationTokens,
    gitAuthorizations,
    apiRequests,
    pullRequests,
    issues,
    reviewThreads,
    searches,
    appCreations,
    branchHeadOf,
    commitSubjectsOf,
    commitToBranch,
    userTokens: () => [...userTokens.keys()],
    expireUserTokens: () => {
      for (const token of userTokens.keys()) userTokens.set(token, 0)
    },
    revokeRefreshTokens: () => refreshTokens.clear(),
    setInstallationPermissions: (permissions: Permissions = grantedAppPermissions) => {
      installationPermissions = permissions
    },
    stop: async () => {
      await server.stop(true)
      rmSync(root, { recursive: true, force: true })
    },
  }
}

export type FakeGitHub = ReturnType<typeof startFakeGitHub>
