import type { GatewayKey } from '@spyria/kernel'
import { type ListedModel, withRetries } from '@spyria/kernel'
import type { LlmGateway, ToolGateway, ToolServer } from '../contracts/repositories.ts'
import { UnsupportedProvider } from '../domain/errors.ts'
import type { ConnectionTool } from '../domain/workspace-connection.ts'

export type LlmGatewaySettings = {
  url: string
  adminUser: string
  adminPassword: string
  timeoutMilliseconds?: number
  toolServerListMilliseconds?: number
  virtualKeyMilliseconds?: number
}
export type ToolServerSetup = { name: string; url: string; oauthConfig?: Record<string, unknown>; isShared?: boolean }
type McpClient = {
  config: { client_id: string; name: string; auth_type: string; headers?: Record<string, unknown> }
  tools?: { name?: string }[]
}
type ListedTool = { name: string; annotations?: { readOnlyHint?: boolean } }
type McpConfig = { id: number; mcp_client: { name: string }; tools_to_execute: string[] }
type BifrostGateway = LlmGateway &
  ToolGateway & {
    url: string
    setUpToolServer(server: ToolServerSetup, logIn?: (authorizeUrl: string) => Promise<void>): Promise<boolean>
    listedModels(): readonly ListedModel[]
    refreshListedModels(): Promise<void>
  }

const notFound = 404
const zaiProviderSetup = {
  network_config: { base_url: 'https://api.z.ai/api/paas/v4' },
  custom_provider_config: {
    base_provider_type: 'openai',
    request_path_overrides: {
      chat_completion: '/chat/completions',
      chat_completion_stream: '/chat/completions',
      list_models: '/models',
    },
  },
}
const providersCreatedOnDemand: Record<string, object> = {
  openai: {},
  anthropic: {},
  mistral: {},
  typesafe: {},
  openrouter: {},
  gemini: {},
  xai: {},
  deepseek: {},
  zai: zaiProviderSetup,
}
const modelListMilliseconds = 60 * 60 * 1000
const modelListSize = 5000
type Prices = { input_cost_per_token?: number; output_cost_per_token?: number }
type ModelDetails = Prices & {
  name: string
  provider: string
  max_input_tokens?: number
  is_deprecated?: boolean
  overridden_pricing?: Prices
}
const dollarsPerMillionOf = (perToken: number | undefined) =>
  perToken === undefined ? undefined : Number((perToken * 1_000_000).toPrecision(12))

export const createLlmGateway = ({
  url,
  adminUser,
  adminPassword,
  timeoutMilliseconds = 10_000,
  toolServerListMilliseconds = 10_000,
  virtualKeyMilliseconds = 60_000,
}: LlmGatewaySettings): BifrostGateway => {
  const authorization = `Basic ${btoa(`${adminUser}:${adminPassword}`)}`
  const virtualKeyValues = new Map<string, { value: string; readAt: number }>()
  let listing: { models: readonly ListedModel[]; loadedAt: number; loading?: Promise<void> } = {
    models: [],
    loadedAt: 0,
  }
  const listModels = async () => {
    const { body } = await request('GET', `/api/models/details?limit=${modelListSize}`)
    return ((body.models ?? []) as ModelDetails[]).flatMap((model): ListedModel[] => {
      const prices = model.overridden_pricing ?? model
      return model.is_deprecated
        ? []
        : [
            {
              id: `${model.provider}/${model.name}`,
              contextWindow: model.max_input_tokens,
              dollarsPerMillionInputTokens: dollarsPerMillionOf(prices.input_cost_per_token),
              dollarsPerMillionOutputTokens: dollarsPerMillionOf(prices.output_cost_per_token),
            },
          ]
    })
  }
  const request = async (method: string, path: string, body?: object, toleratedStatus = notFound) => {
    const send = (signal: AbortSignal) =>
      fetch(`${url}${path}`, {
        method,
        headers: { authorization, 'content-type': 'application/json' },
        body: body && JSON.stringify(body),
        signal,
      })
    const response =
      method === 'POST'
        ? await send(AbortSignal.timeout(timeoutMilliseconds))
        : await withRetries(send, { timeoutMilliseconds })
    if (!response.ok && response.status !== toleratedStatus)
      throw new Error(`The gateway answered ${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')} with ${response.status}`)
    const text = response.ok ? await response.text() : ''
    return { found: response.ok, body: JSON.parse(text || '{}') as Record<string, unknown> }
  }
  const virtualKeyOf = (body: Record<string, unknown>) => body.virtual_key as { id: string; value: string }
  const bindingOf = (keys: GatewayKey[]) => ({
    provider_configs: [...new Set(keys.map((key) => key.provider))].map((provider) => ({
      provider,
      weight: 1,
      allowed_models: ['*'],
      key_ids: keys.filter((key) => key.provider === provider).map((key) => key.id),
    })),
  })
  let toolServerList: { servers: Promise<ToolServer[]>; loadedAt: number } | undefined
  const mcpClients = async () => (await request('GET', '/api/mcp/clients')).body.clients as McpClient[]
  const clientNamed = async (name: string) => (await mcpClients()).find(({ config }) => config.name === name)
  const freshToolServers = async () =>
    (await mcpClients()).map(
      ({ config, tools }): ToolServer => ({
        id: config.client_id,
        name: config.name,
        tools: (tools ?? []).flatMap((tool) => tool.name ?? []),
        isPersonal: config.auth_type === 'per_user_oauth',
      }),
    )
  const toolServers = () => {
    if (!toolServerList || Date.now() - toolServerList.loadedAt > toolServerListMilliseconds) {
      const servers = freshToolServers()
      toolServerList = { servers, loadedAt: Date.now() }
      servers.catch(() => {
        if (toolServerList?.servers === servers) toolServerList = undefined
      })
    }
    return toolServerList.servers
  }
  const toolConfigsOf = async (virtualKeyId: string) => {
    const { body } = await request('GET', `/api/governance/virtual-keys/${virtualKeyId}`)
    return ((body.virtual_key as { mcp_configs?: McpConfig[] }).mcp_configs ?? []).map((config) => ({
      id: config.id,
      mcp_client_name: config.mcp_client.name,
      tools_to_execute: config.tools_to_execute,
    }))
  }
  const finishToolConsent = async (callbackQuery: string) => {
    const response = await fetch(`${url}/api/oauth/callback${callbackQuery}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMilliseconds),
    })
    return /auth-success|status=success/.test(response.headers.get('location') ?? '')
  }
  const mcpRequest = (virtualKeyValue: string | undefined, method: string, params?: object) =>
    fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${virtualKeyValue}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMilliseconds),
    })
  const listedToolsOf = async (virtualKeyValue: string | undefined) => {
    const { result } = (await (await mcpRequest(virtualKeyValue, 'tools/list')).json()) as {
      result?: { tools?: ListedTool[] }
    }
    return result?.tools ?? []
  }
  const gateway: BifrostGateway = {
    url,
    refreshListedModels: () => {
      listing.loading ??= listModels().then(
        (models) => {
          listing = { models, loadedAt: Date.now() }
        },
        () => {
          listing.loading = undefined
        },
      )
      return listing.loading
    },
    listedModels: () => {
      if (listing.models.length === 0 || Date.now() - listing.loadedAt > modelListMilliseconds)
        void gateway.refreshListedModels()
      return listing.models
    },
    toolServers,
    finishToolConsent,
    setUpToolServer: async ({ name, url: endpoint, oauthConfig = {}, isShared }, logIn) => {
      if (name.includes('-')) throw new Error(`A tool server name cannot contain "-": ${name}`)
      if ((await freshToolServers()).some((server) => server.name === name)) return false
      if (!isShared && !logIn) throw new Error(`Setting up ${name} needs an operator to log in to it`)
      const { body } = await request('POST', '/api/mcp/client', {
        name,
        connection_type: 'http',
        connection_string: endpoint,
        tools_to_execute: ['*'],
        ...(isShared ? { auth_type: 'none' } : { auth_type: 'per_user_oauth', oauth_config: oauthConfig }),
      })
      if (logIn && !isShared) {
        await logIn(String(body.authorize_url))
        await request('POST', `/api/mcp/client/${body.oauth_config_id}/complete-oauth`)
      }
      toolServerList = undefined
      return true
    },
    addToolServer: async ({ name, url: endpoint, secretHeader }) => {
      await request('POST', '/api/mcp/client', {
        name,
        connection_type: 'http',
        connection_string: endpoint,
        tools_to_execute: ['*'],
        auth_type: secretHeader ? 'headers' : 'none',
        ...(secretHeader && { headers: { [secretHeader.name]: secretHeader.value } }),
      })
      toolServerList = undefined
      const listingKey = virtualKeyOf(
        (
          await request('POST', '/api/governance/virtual-keys', {
            name: `vk_listing_${crypto.randomUUID()}`,
            is_active: true,
            mcp_configs: [{ mcp_client_name: name, tools_to_execute: ['*'] }],
          })
        ).body,
      )
      try {
        return (await listedToolsOf(listingKey.value)).map(
          (tool): ConnectionTool => ({
            name: tool.name.slice(name.length + 1),
            readOnly: tool.annotations?.readOnlyHint === true,
          }),
        )
      } finally {
        await request('DELETE', `/api/governance/virtual-keys/${listingKey.id}`)
      }
    },
    replaceToolServerHeader: async (name, secretHeader) => {
      const client = await clientNamed(name)
      if (!client) throw new Error(`The gateway has no tool server ${name}`)
      await request('PUT', `/api/mcp/client/${client.config.client_id}`, {
        ...client.config,
        headers: secretHeader ? { [secretHeader.name]: secretHeader.value } : {},
      })
    },
    removeToolServer: async (name) => {
      const client = await clientNamed(name)
      if (client) await request('DELETE', `/api/mcp/client/${client.config.client_id}`)
      toolServerList = undefined
    },
    setToolGrants: async (virtualKeyId, workspaceGrants) => {
      const [servers, configs] = await Promise.all([toolServers(), toolConfigsOf(virtualKeyId)])
      const granted = servers.flatMap(({ name, isPersonal }) => {
        const config = configs.find(({ mcp_client_name }) => mcp_client_name === name)
        const tools = isPersonal ? (config?.tools_to_execute ?? ['*']) : (workspaceGrants[name] ?? [])
        return tools.length > 0
          ? [{ ...(config && { id: config.id }), mcp_client_name: name, tools_to_execute: tools }]
          : []
      })
      const isUnchanged =
        granted.length === configs.length &&
        granted.every((grant) => {
          const config = configs.find(({ mcp_client_name }) => mcp_client_name === grant.mcp_client_name)
          return config && config.tools_to_execute.join() === grant.tools_to_execute.join()
        })
      if (!isUnchanged) await request('PUT', `/api/governance/virtual-keys/${virtualKeyId}`, { mcp_configs: granted })
    },
    startToolConsent: async (virtualKeyId, server) => {
      const virtualKeyValue = await gateway.virtualKeyValue(virtualKeyId)
      const readOnlyTool = (await listedToolsOf(virtualKeyValue)).find(
        (tool) => tool.name.startsWith(`${server.name}-`) && tool.annotations?.readOnlyHint === true,
      )
      const consentTool = readOnlyTool?.name ?? `${server.name}-${server.tools[0]}`
      const response = await mcpRequest(virtualKeyValue, 'tools/call', { name: consentTool, arguments: {} })
      const flowId = (await response.text()).match(/flow=([0-9a-f-]{36})/)?.[1]
      if (!flowId) throw new Error(`The gateway started no consent for ${server.name}`)
      return String((await request('GET', `/api/oauth/per-user/flows/${flowId}/start`)).body.authorize_url)
    },
    toolSessions: async (virtualKeyId, server) =>
      (
        (await request('GET', `/api/mcp/sessions?virtual_key_id=${virtualKeyId}&mcp_client_id=${server.id}`)).body
          .sessions as { id: string; status: string; kind: string }[]
      ).filter(({ kind }) => kind !== 'flow'),
    removeToolSession: async (sessionId) => {
      await request('DELETE', `/api/mcp/sessions/${sessionId}`)
    },
    addProviderKey: async ({ provider, name, secret }) => {
      const keyBody = { name, value: secret.reveal(), models: ['*'], weight: 1 }
      let added = await request('POST', `/api/providers/${provider}/keys`, keyBody)
      const setup = providersCreatedOnDemand[provider]
      if (!added.found && setup) {
        await request('POST', '/api/providers', { provider, keys: [], ...setup })
        added = await request('POST', `/api/providers/${provider}/keys`, keyBody)
      }
      if (!added.found) throw new UnsupportedProvider(provider)
      listing = { models: listing.models, loadedAt: 0 }
      void gateway.refreshListedModels()
      return { provider, id: String(added.body.id) }
    },
    removeProviderKey: async ({ provider, id }) => {
      await request('DELETE', `/api/providers/${provider}/keys/${id}`)
    },
    saveVirtualKey: async ({ id, keys }) => {
      if (id && (await request('PUT', `/api/governance/virtual-keys/${id}`, bindingOf(keys))).found) return id
      const { body } = await request('POST', '/api/governance/virtual-keys', {
        name: `vk_${crypto.randomUUID()}`,
        is_active: true,
        ...bindingOf(keys),
      })
      const created = virtualKeyOf(body)
      virtualKeyValues.set(created.id, { value: created.value, readAt: Date.now() })
      return created.id
    },
    removeVirtualKey: async (id) => {
      virtualKeyValues.delete(id)
      await request('DELETE', `/api/governance/virtual-keys/${id}`)
    },
    virtualKeyValue: async (id) => {
      const cached = virtualKeyValues.get(id)
      if (cached && Date.now() - cached.readAt < virtualKeyMilliseconds) return cached.value
      const read = await request('GET', `/api/governance/virtual-keys/${id}`)
      if (!read.found) return undefined
      const { value } = virtualKeyOf(read.body)
      virtualKeyValues.set(id, { value, readAt: Date.now() })
      return value
    },
  }
  return gateway
}
