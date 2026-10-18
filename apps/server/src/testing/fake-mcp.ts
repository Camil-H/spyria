type Grant = { user: string; clientId: string }

const randomToken = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
const sha256Base64Url = async (text: string) =>
  Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('base64url')
const whoamiTool = {
  name: 'whoami',
  description: 'Who the token belongs to',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true },
}
const sharedTools = [
  {
    name: 'lookup',
    description: 'Reads a record',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'update',
    description: 'Changes a record',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    annotations: { readOnlyHint: false },
  },
]
const sharedUser = 'shared'
export const sharedToolServer = 'crm'
export const sharedSecretHeader = 'x-crm-key'

export const createFakeMcp = () => {
  const clients = new Map<string, { secret: string; redirectUris: string[] }>()
  const codes = new Map<string, Grant & { redirectUri: string; challenge: string }>()
  const tokens = new Map<string, Grant>()
  const records: { tool: string; user: string }[] = []
  const issue = (grant: Grant) => {
    const [access, refresh] = [randomToken('at'), randomToken('rt')]
    tokens.set(access, grant).set(refresh, grant)
    return { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope: 'read' }
  }
  const mcp = async (request: Request, base: string, isShared = false) => {
    const user = isShared
      ? (request.headers.get(sharedSecretHeader) ?? sharedUser)
      : tokens.get(request.headers.get('authorization')?.replace(/^Bearer /i, '') ?? '')?.user
    if (!user)
      return Response.json(
        { error: 'invalid_token' },
        {
          status: 401,
          headers: {
            'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
          },
        },
      )
    if (request.method !== 'POST') return new Response(null, { status: request.method === 'DELETE' ? 200 : 405 })
    const message = await request.json()
    if (message.id === undefined) return new Response(null, { status: 202 })
    if (message.method === 'tools/call') records.push({ tool: message.params.name, user })
    const result =
      message.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } }
        : message.method === 'tools/list'
          ? { tools: isShared ? sharedTools : [whoamiTool] }
          : message.method === 'tools/call'
            ? { content: [{ type: 'text', text: isShared ? `ran ${message.params.name}` : `you are ${user}` }] }
            : {}
    return Response.json({ jsonrpc: '2.0', id: message.id, result })
  }
  const token = async (request: Request) => {
    const form = new URLSearchParams(await request.text())
    const basic = request.headers.get('authorization')?.match(/^Basic (.+)$/)?.[1]
    const [clientId = '', secret = ''] = basic
      ? atob(basic).split(':').map(decodeURIComponent)
      : [form.get('client_id') ?? '', form.get('client_secret') ?? '']
    const client = clients.get(clientId)
    if (!client || (client.secret && client.secret !== secret))
      return Response.json({ error: 'invalid_client' }, { status: 401 })
    if (form.get('grant_type') === 'refresh_token') {
      const grant = tokens.get(form.get('refresh_token') ?? '')
      tokens.delete(form.get('refresh_token') ?? '')
      return grant ? Response.json(issue(grant)) : Response.json({ error: 'invalid_grant' }, { status: 400 })
    }
    const code = codes.get(form.get('code') ?? '')
    codes.delete(form.get('code') ?? '')
    const isValid =
      code?.clientId === clientId &&
      code.redirectUri === form.get('redirect_uri') &&
      (await sha256Base64Url(form.get('code_verifier') ?? '')) === code.challenge
    return isValid ? Response.json(issue(code)) : Response.json({ error: 'invalid_grant' }, { status: 400 })
  }
  const fetch = async (request: Request) => {
    const url = new URL(request.url)
    const base = url.origin
    const params = url.searchParams
    if (url.pathname === '/_records') return Response.json(records)
    if (url.pathname === '/_admin/expire') {
      for (const [value, grant] of tokens) if (grant.user === params.get('user')) tokens.delete(value)
      return new Response('expired')
    }
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
      return Response.json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['read'] })
    if (url.pathname.startsWith('/.well-known/'))
      return Response.json({
        issuer: base,
        authorization_endpoint: `${base.replace('host.docker.internal', 'localhost')}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
      })
    if (url.pathname === '/register') {
      const body = await request.json()
      const clientId = randomToken('client')
      const secret = body.token_endpoint_auth_method === 'none' ? '' : randomToken('secret')
      clients.set(clientId, { secret, redirectUris: body.redirect_uris ?? [] })
      return Response.json({ ...body, client_id: clientId, ...(secret && { client_secret: secret }) }, { status: 201 })
    }
    if (url.pathname === '/authorize') {
      const redirectUri = params.get('redirect_uri') ?? ''
      if (!clients.get(params.get('client_id') ?? '')?.redirectUris.includes(redirectUri))
        return new Response('unknown client or redirect_uri', { status: 400 })
      const user =
        params.get('user') ?? request.headers.get('cookie')?.match(/fake_mcp_user=([^;]+)/)?.[1] ?? 'fake-admin'
      const code = randomToken('code')
      const clientId = params.get('client_id') ?? ''
      codes.set(code, { user, clientId, redirectUri, challenge: params.get('code_challenge') ?? '' })
      const target = new URL(redirectUri)
      target.search = new URLSearchParams({ code, state: params.get('state') ?? '' }).toString()
      return Response.redirect(target.toString(), 302)
    }
    if (url.pathname === '/token') return token(request)
    if (url.pathname === '/mcp') return mcp(request, base)
    if (url.pathname === '/shared/mcp') return mcp(request, base, true)
    return new Response('not found', { status: 404 })
  }
  return {
    fetch,
    records,
    secrets: () => [...tokens.keys(), ...[...clients.values()].map((client) => client.secret).filter(Boolean)],
  }
}

if (import.meta.main) Bun.serve({ port: Number(process.env.PORT ?? 3001), fetch: createFakeMcp().fetch })
