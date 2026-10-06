import type { LlmGateway } from '../contracts/repositories.ts'
import { UnsupportedProvider } from '../domain/errors.ts'
import type { GatewayKey } from '../domain/llm-credential.ts'

export type LlmGatewaySettings = { url: string; adminUser: string; adminPassword: string }

const notFound = 404
const conflict = 409
const providersCreatedOnDemand = ['openai', 'anthropic', 'mistral']

export const createLlmGateway = ({
  url,
  adminUser,
  adminPassword,
}: LlmGatewaySettings): LlmGateway & { url: string; registerFakeProvider(fakeLlmUrl: string): Promise<void> } => {
  const authorization = `Basic ${btoa(`${adminUser}:${adminPassword}`)}`
  const virtualKeyValues = new Map<string, string>()
  const request = async (method: string, path: string, body?: object, toleratedStatus = notFound) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { authorization, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    })
    if (!response.ok && response.status !== toleratedStatus)
      throw new Error(`The gateway answered ${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')} with ${response.status}`)
    return { found: response.ok, body: response.ok ? ((await response.json()) as Record<string, unknown>) : {} }
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
  return {
    url,
    registerFakeProvider: async (fakeLlmUrl) => {
      const fake = {
        provider: 'fake',
        keys: [],
        network_config: { base_url: fakeLlmUrl, max_retries: 0 },
        custom_provider_config: { base_provider_type: 'openai' },
      }
      await request('POST', '/api/providers', fake, conflict)
    },
    addProviderKey: async ({ provider, name, secret }) => {
      const keyBody = { name, value: secret.reveal(), models: ['*'], weight: 1 }
      let added = await request('POST', `/api/providers/${provider}/keys`, keyBody)
      if (!added.found && providersCreatedOnDemand.includes(provider)) {
        await request('POST', '/api/providers', { provider, keys: [] })
        added = await request('POST', `/api/providers/${provider}/keys`, keyBody)
      }
      if (!added.found) throw new UnsupportedProvider(provider)
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
      virtualKeyValues.set(created.id, created.value)
      return created.id
    },
    removeVirtualKey: async (id) => {
      virtualKeyValues.delete(id)
      await request('DELETE', `/api/governance/virtual-keys/${id}`)
    },
    virtualKeyValue: async (id) => {
      const cached = virtualKeyValues.get(id)
      if (cached) return cached
      const read = await request('GET', `/api/governance/virtual-keys/${id}`)
      if (!read.found) return undefined
      const { value } = virtualKeyOf(read.body)
      virtualKeyValues.set(id, value)
      return value
    },
  }
}
