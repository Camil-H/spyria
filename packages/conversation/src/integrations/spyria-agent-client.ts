import {
  type AgentClient,
  type AgentConversation,
  type AgentEndpoint,
  type AgentLlmChoice,
  AgentStartFailure,
  type PiLaunch,
  type PiModel,
  type RepositoryCheckout,
  type SubConversation,
} from '../contracts/agent.ts'
import type { AgentEvent } from '../domain/agent-events.ts'
import { delegateTimeoutSeconds } from '../domain/delegation.ts'
import { githubToolsPath } from '../domain/pull-requests.ts'
import { type HarnessLaunch, piModelOf } from '../domain/session-routing.ts'
import { spyriaToolTimeoutSeconds } from '../domain/tool-calls.ts'

export type AgentLlm = { model: string }

const requestTimeoutMilliseconds = 30_000
const checkoutTimeoutMilliseconds = 120_000
const bundleTimeoutMilliseconds = 110_000
const githubToolTimeoutSeconds = 120
const notFoundStatus = 404

const send = (
  endpoint: AgentEndpoint,
  method: string,
  path: string,
  body?: object,
  timeoutMilliseconds = requestTimeoutMilliseconds,
) =>
  endpoint.transport.fetch({
    method,
    path,
    headers: { 'content-type': 'application/json', 'x-session-api-key': endpoint.apiKey },
    body: body && JSON.stringify(body),
    timeoutMilliseconds,
  })

const repositoryLaunchOf = ({ url, token, baseBranch, workingBranch }: RepositoryCheckout) => ({
  url,
  token,
  base_branch: baseBranch,
  working_branch: workingBranch,
})
const call = async (
  endpoint: AgentEndpoint,
  method: string,
  path: string,
  body?: object,
  timeoutMilliseconds?: number,
) => {
  const response = await send(endpoint, method, path, body, timeoutMilliseconds)
  if (response.status === notFoundStatus && method === 'GET') return undefined
  if (response.status >= 300) throw new Error(`spyria-agent answered ${method} ${path} with ${response.status}`)
  return JSON.parse(response.body || '{}') as Record<string, unknown>
}

const spyriaAgentEventOf = (data: string): AgentEvent | undefined => {
  try {
    const { id, seq, timestamp, completed, update } = JSON.parse(data)
    return typeof id === 'string' && typeof timestamp === 'string' && typeof update === 'object'
      ? { id, kind: 'ACPUpdate', timestamp, seq, completed, update }
      : undefined
  } catch {
    return undefined
  }
}

const mcpServerOf = (endpoint: AgentEndpoint, path: string, token: string) => ({
  url: endpoint.transport.gatewayUrl.replace(/\/v1$/, path),
  transport: 'http',
  headers: { Authorization: `Bearer ${token}` },
})

const claudeCodeSettings = [
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
  'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1',
  'CLAUDE_CODE_MAX_RETRIES=0',
]

const backgroundFeaturesOff = `[analytics]
enabled = false

[feedback]
enabled = false

[features]
plugins = false
remote_plugin = false
apps = false
`

const subscriptionConfig = `forced_login_method = "chatgpt"
check_for_update_on_startup = false
cli_auth_credentials_store = "file"

${backgroundFeaturesOff}`

const codexSubscriptionCommand = [
  'env',
  `SPYRIA_CODEX_CONFIG=${subscriptionConfig}`,
  'sh',
  '-c',
  'set -e; printf %s "$SPYRIA_CODEX_CONFIG" > "$HOME/.codex/config.toml.$$"; mv "$HOME/.codex/config.toml.$$" "$HOME/.codex/config.toml"; exec codex-acp',
]

const harnessLaunches: Record<HarnessLaunch, string[]> = {
  'claude-code-subscription': ['env', ...claudeCodeSettings, 'claude-agent-acp'],
  'codex-subscription': codexSubscriptionCommand,
}

const harnessConversationOf = (
  endpoint: AgentEndpoint,
  llmToken: string,
  harness: HarnessLaunch,
  { resumeSessionId, adapterModel, effort }: AgentLlmChoice,
  hasRepository: boolean,
) => ({
  agent: {
    acp_command: harnessLaunches[harness],
    mcp_config: {
      spyria: mcpServerOf(endpoint, '/mcp', llmToken),
      ...(hasRepository && { github: mcpServerOf(endpoint, githubToolsPath, llmToken) }),
    },
    ...(resumeSessionId && { acp_resume_session_id: resumeSessionId }),
    ...(adapterModel && { acp_model: adapterModel }),
    ...(effort && { acp_thought_level: effort }),
  },
  secrets: {},
})

const piSettings = {
  quietStartup: true,
  enableInstallTelemetry: false,
  retry: { enabled: false },
  extensions: ['/usr/local/lib/spyria/pi/spyria-compaction.ts', '/usr/local/lib/spyria/pi/spyria-plan.ts'],
}
const piProviderOf = (baseUrl: string, api: string, models: readonly PiModel[]) => ({
  baseUrl,
  api,
  apiKey: `\${SPYRIA_LLM_TOKEN}`,
  models: models.map(({ id, name, reasoning, contextWindow }) => ({
    id,
    name,
    reasoning,
    ...(contextWindow !== undefined && { contextWindow }),
    ...(api === 'openai-completions' && !id.startsWith('openai/') && { compat: { supportsDeveloperRole: false } }),
  })),
})
const piMcpServerOf = (gatewayUrl: string, path: string) => ({
  url: gatewayUrl.replace(/\/v1$/, path),
  headers: { Authorization: `Bearer \${SPYRIA_MCP_TOKEN}` },
  exposure: 'direct',
})
const piLauncherOf = (directory: string) => `set -e
export PI_CODING_AGENT_DIR="$HOME/.pi/${directory}"
mkdir -p "$PI_CODING_AGENT_DIR"
write() { printf %s "$2" > "$PI_CODING_AGENT_DIR/$1.tmp"; mv "$PI_CODING_AGENT_DIR/$1.tmp" "$PI_CODING_AGENT_DIR/$1"; }
write models.json "$SPYRIA_PI_MODELS"
write settings.json "$SPYRIA_PI_SETTINGS"
write mcp.json "$SPYRIA_PI_MCP"
exec pi --mode rpc --no-themes`

export const piCommandOf = (
  gatewayUrl: string,
  { models, compactionModel, compaction }: PiLaunch,
  { sub, hasRepository = false }: { sub: boolean; hasRepository?: boolean },
) => {
  const anthropicModels = models.filter((model) => model.id.startsWith('anthropic/'))
  const otherModels = models.filter((model) => !anthropicModels.includes(model))
  const providers = {
    ...(otherModels.length > 0 && { spyria: piProviderOf(gatewayUrl, 'openai-completions', otherModels) }),
    ...(anthropicModels.length > 0 && {
      'spyria-anthropic': piProviderOf(gatewayUrl.replace(/\/v1$/, ''), 'anthropic-messages', anthropicModels),
    }),
  }
  const mcpServers = {
    spyria: { ...piMcpServerOf(gatewayUrl, '/mcp'), timeout: spyriaToolTimeoutSeconds },
    ...(!sub && { router: { ...piMcpServerOf(gatewayUrl, '/mcp/router'), timeout: delegateTimeoutSeconds } }),
    ...(!sub &&
      hasRepository && {
        github: { ...piMcpServerOf(gatewayUrl, githubToolsPath), timeout: githubToolTimeoutSeconds },
      }),
  }
  return [
    'env',
    'PI_OFFLINE=1',
    'PI_SKIP_VERSION_CHECK=1',
    'PI_TELEMETRY=0',
    `SPYRIA_COMPACTION_MODEL=${piModelOf(compactionModel)}`,
    `SPYRIA_PI_MODELS=${JSON.stringify({ providers })}`,
    `SPYRIA_PI_SETTINGS=${JSON.stringify({ ...piSettings, ...(compaction && { compaction }) })}`,
    `SPYRIA_PI_MCP=${JSON.stringify({ mcpServers })}`,
    'sh',
    '-c',
    piLauncherOf(sub ? 'sub' : 'agent'),
  ]
}

const piConversationOf = (
  endpoint: AgentEndpoint,
  llmToken: string,
  pi: PiLaunch,
  { resumeSessionId, adapterModel, effort }: AgentLlmChoice,
  sub: SubConversation | undefined,
  hasRepository: boolean,
) => ({
  agent: {
    acp_command: piCommandOf(endpoint.transport.gatewayUrl, pi, { sub: Boolean(sub), hasRepository }),
    adapter: 'pi-rpc',
    ...(resumeSessionId && { acp_resume_session_id: resumeSessionId }),
    ...(adapterModel && { acp_model: adapterModel }),
    ...(adapterModel && effort && { acp_thought_level: effort }),
  },
  secrets: {
    SPYRIA_LLM_TOKEN: { kind: 'StaticSecret', value: llmToken },
    SPYRIA_MCP_TOKEN: { kind: 'StaticSecret', value: llmToken },
  },
})

export const createSpyriaAgentClient = (): AgentClient => ({
  createConversation: async (conversation, llmToken, llm, sub, checkout) => {
    const created = await call(
      conversation,
      'POST',
      '/api/conversations',
      {
        id: conversation.conversationId,
        ...('harness' in llm
          ? harnessConversationOf(conversation, llmToken, llm.harness, llm, Boolean(checkout))
          : piConversationOf(conversation, llmToken, llm.pi, llm, sub, Boolean(checkout))),
        workspace: { kind: 'LocalWorkspace', working_dir: '/workspace/project' },
        autotitle: false,
        ...(sub && { parent_conversation_id: sub.parentConversationId }),
        ...(checkout && { repository: repositoryLaunchOf(checkout) }),
      },
      checkout && checkoutTimeoutMilliseconds,
    )
    if (created?.execution_status === 'error') {
      await call(conversation, 'DELETE', `/api/conversations/${conversation.conversationId}`).catch(() => undefined)
      throw new AgentStartFailure(String(created.error))
    }
  },
  switchModel: async (conversation, model, thoughtLevel) => {
    await call(conversation, 'POST', `/api/conversations/${conversation.conversationId}/switch_acp_model`, {
      ...(model && { model }),
      ...(thoughtLevel && { thoughtLevel }),
    })
  },
  sendMessage: async (conversation, text) => {
    await call(conversation, 'POST', `/api/conversations/${conversation.conversationId}/events`, {
      role: 'user',
      content: [{ type: 'text', text }],
      run: true,
    })
  },
  answerQuestion: async (conversation, questionId, answer) =>
    (
      await send(
        conversation,
        'POST',
        `/api/conversations/${conversation.conversationId}/questions/${questionId}`,
        answer,
      )
    ).status,
  setPlanMode: async (conversation, enabled) =>
    (await send(conversation, 'POST', `/api/conversations/${conversation.conversationId}/plan_mode`, { enabled }))
      .status,
  statusOf: async (conversation) => {
    const read = await call(conversation, 'GET', `/api/conversations/${conversation.conversationId}`)
    return read && String(read.execution_status)
  },
  interrupt: async (conversation) => {
    await call(conversation, 'POST', `/api/conversations/${conversation.conversationId}/interrupt`, {})
  },
  deleteConversation: async (conversation) => {
    await call(conversation, 'DELETE', `/api/conversations/${conversation.conversationId}`)
  },
  readWorkspace: (endpoint, path) => call(endpoint, 'GET', path),
  bundleBranch: async (endpoint, branch, prerequisite) => {
    const response = await send(
      endpoint,
      'POST',
      '/api/workspace/bundle',
      { branch, prerequisite },
      bundleTimeoutMilliseconds,
    )
    const { bundle, error } = JSON.parse(response.body || '{}') as { bundle?: string; error?: string }
    if (response.status === 200 && typeof bundle === 'string') return { bundle }
    return { failure: error ?? `spyria-agent answered the bundle request with ${response.status}` }
  },
  actOnWorkspace: async (endpoint, action, body) => {
    const response = await send(endpoint, 'POST', `/api/workspace/${action}`, body, bundleTimeoutMilliseconds)
    const { error, ...answer } = JSON.parse(response.body || '{}') as { error?: string }
    if (response.status === 200) return answer
    return { failure: error ?? `spyria-agent answered the ${action} request with ${response.status}` }
  },
  openEvents: (conversation: AgentConversation, last, listener) => {
    const { conversationId } = conversation
    const after = last?.id.startsWith(`${conversationId}:`) ? (last.seq ?? 0) : 0
    const socket = conversation.transport.openSocket(`/sockets/events/${conversationId}?after=${after}`, {
      onOpen: () => socket.send(JSON.stringify({ type: 'auth', session_api_key: conversation.apiKey })),
      onMessage: (data) => {
        const event = spyriaAgentEventOf(data)
        if (event) listener.onEvent(event)
      },
      onClose: listener.onClose,
    })
    return socket
  },
})
