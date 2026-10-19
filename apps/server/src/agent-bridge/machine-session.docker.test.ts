import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { readSpyriaAgentImage } from '../spyria-agent-image.ts'
import { waitFor } from '../testing/testing.ts'

setDefaultTimeout(240_000)
const docker = (...args: string[]) => Bun.spawnSync(['docker', ...args], { stderr: 'pipe' })
const spyriaImage = await readSpyriaAgentImage()
if (!spyriaImage || docker('image', 'inspect', spyriaImage).exitCode !== 0)
  throw new Error('Spyria image missing: run bun run agent:build')

type ProviderRequest = {
  path: string
  model?: string
  tools?: unknown[]
  output_config?: { effort?: string }
  reasoning?: { effort?: string }
}
const encoder = new TextEncoder()
const eventStreamOf = (events: [string, object][]) =>
  new Response(
    new ReadableStream({
      start: (controller) => {
        for (const [event, data] of events)
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        controller.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
const anthropicTextOf = (model: string) =>
  eventStreamOf([
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      },
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    ],
    ['message_stop', { type: 'message_stop' }],
  ])
const responsesText = () => {
  const item = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'Done.', annotations: [] }],
  }
  return eventStreamOf([
    ['response.created', { type: 'response.created', response: { id: 'r1', status: 'in_progress', output: [] } }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
    [
      'response.completed',
      {
        type: 'response.completed',
        response: {
          id: 'r1',
          status: 'completed',
          output: [item],
          usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
        },
      },
    ],
  ])
}
const requests: ProviderRequest[] = []
const provider = Bun.serve({
  port: 0,
  idleTimeout: 120,
  fetch: async (request) => {
    const { pathname } = new URL(request.url)
    const body = (await request.json().catch(() => ({}))) as Omit<ProviderRequest, 'path'> & { stream?: boolean }
    requests.push({ path: pathname, ...body })
    if (pathname.endsWith('/messages') && body.stream) return anthropicTextOf(String(body.model))
    if (pathname.endsWith('/messages'))
      return Response.json({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: '{"title":"Effort"}' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      })
    if (pathname.endsWith('/responses')) return responsesText()
    if (pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 10 })
    return Response.json({ models: [] })
  },
})
const providerUrl = `http://host.docker.internal:${provider.port}`

const apiKey = 'test-api-key-0123456789abcdef'
const container = `spyria-test-${crypto.randomUUID().slice(0, 8)}-effort`
const started = docker(
  ...['run', '-d', '--rm', '--name', container, '-e', `OH_SESSION_API_KEYS_0=${apiKey}`, '-p', '127.0.0.1::8000'],
  ...['--add-host', 'host.docker.internal:host-gateway', '--read-only', '--tmpfs', '/tmp:exec'],
  ...[
    '--tmpfs',
    '/home/openhands:uid=10001,gid=10001',
    '--tmpfs',
    '/workspace:uid=10001,gid=10001',
    '-u',
    '10001:10001',
  ],
  spyriaImage,
)
if (started.exitCode !== 0) throw new Error(started.stderr.toString())
const agentUrl = `http://${docker('port', container, '8000').stdout.toString().trim().split('\n')[0]}`
afterAll(() => {
  docker('rm', '-f', container)
  void provider.stop(true)
})

const call = async (path: string, body: object) => {
  const response = await fetch(`${agentUrl}${path}`, {
    method: 'POST',
    headers: { 'x-session-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(response.status).toBeLessThan(300)
  return (await response.json()) as { id?: string; error?: string }
}
const conversationOf = async (agent: object, secrets: Record<string, { value: string }> = {}) => {
  await waitFor(
    () =>
      fetch(`${agentUrl}/ready`).then(
        (response) => response.ok,
        () => false,
      ),
    30_000,
  )
  const { id, error } = (await call('/api/conversations', {
    agent,
    secrets,
    workspace: { kind: 'LocalWorkspace', working_dir: '/workspace/project' },
  })) as { id?: string; error?: string }
  expect(error).toBeUndefined()
  const turnEnds: unknown[] = []
  const socket = new WebSocket(`${agentUrl.replace('http', 'ws')}/sockets/events/${id}`)
  socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'auth', session_api_key: apiKey })))
  socket.addEventListener('message', (message) => {
    if (JSON.parse(String(message.data)).update?.sessionUpdate === 'turn_end') turnEnds.push(message.data)
  })
  const turn = async (text: string) => {
    const ended = turnEnds.length
    await call(`/api/conversations/${id}/events`, { role: 'user', content: [{ type: 'text', text }], run: true })
    await waitFor(() => turnEnds.length > ended, 120_000)
  }
  const setEffort = (thoughtLevel: string) => call(`/api/conversations/${id}/switch_acp_model`, { thoughtLevel })
  return { turn, setEffort, close: () => socket.close() }
}

test('Claude Code: the launch effort and a later effort change reach the Anthropic request on the same session', async () => {
  const claude = await conversationOf({
    acp_command: [
      ...['env', `ANTHROPIC_BASE_URL=${providerUrl}`, 'ANTHROPIC_API_KEY=sk-ant-fake-effort-key'],
      ...['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1', 'DISABLE_AUTOUPDATER=1', 'claude-agent-acp'],
    ],
    acp_thought_level: 'max',
  })
  const turnEfforts = () =>
    requests
      .filter(({ path, tools }) => path.endsWith('/messages') && tools?.length)
      .map((request) => request.output_config?.effort)
  await claude.turn('First')
  await claude.setEffort('low')
  await claude.turn('Second')
  claude.close()
  expect(turnEfforts()).toEqual(['max', 'low'])
})

test('Codex: the launch effort and a later effort change reach the Responses request on the same session', async () => {
  const config = [
    'model = "gpt-6.1-sol"',
    'model_provider = "fake"',
    'check_for_update_on_startup = false',
    '[model_providers.fake]',
    'name = "fake"',
    `base_url = "${providerUrl}/v1"`,
    'wire_api = "responses"',
    'env_key = "FAKE_OPENAI_KEY"',
    '[analytics]',
    'enabled = false',
    '[feedback]',
    'enabled = false',
  ].join('\n')
  const codex = await conversationOf(
    {
      acp_command: [
        'sh',
        '-c',
        'mkdir -p "$HOME/.codex" && printf %s "$SPYRIA_CODEX_CONFIG" > "$HOME/.codex/config.toml" && exec codex-acp',
      ],
      acp_thought_level: 'high',
    },
    { SPYRIA_CODEX_CONFIG: { value: config }, FAKE_OPENAI_KEY: { value: 'fake-effort-key' } },
  )
  const turnEfforts = () =>
    requests
      .filter(({ path, model }) => path.endsWith('/responses') && model === 'gpt-6.1-sol')
      .map((request) => request.reasoning?.effort)
  await codex.turn('First')
  await codex.setEffort('xhigh')
  await codex.turn('Second')
  codex.close()
  expect(turnEfforts()).toEqual(['high', 'xhigh'])
})
