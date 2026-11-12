import { afterAll, expect, test } from 'bun:test'
import {
  argumentsOf,
  CommandError,
  rpcAnswerOf,
  runSpyriaCommand,
  serviceHelpOf,
  serviceNamed,
  servicesHelpOf,
  type Tool,
  toolHelpOf,
} from './spyria-command.ts'

const listIssues: Tool = {
  name: 'github_ab12cd-list_issues',
  description: 'List issues in a GitHub repository. For pagination, use the cursor.',
  inputSchema: {
    type: 'object',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      perPage: { type: 'number', description: 'Results per page. At most 100.' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Filter by labels' },
      state: { type: 'string', enum: ['OPEN', 'CLOSED'] },
    },
  },
}
const search: Tool = { name: 'notion_ef34ab-API-post-search', description: 'Search pages', inputSchema: {} }
const tools = [listIssues, search, { name: 'github_ab12cd-get_me', description: 'Who you are' }]

test('the services list names each connected service with its tool count, and a service by its name without the suffix', () => {
  expect(servicesHelpOf(tools)).toStartWith(
    'Connected services:\n  github_ab12cd  2 tools\n  notion_ef34ab  1 tool\n\nUsage:',
  )
  expect(servicesHelpOf([])).toStartWith('No connected service is available to you in this chat.')
  expect(serviceNamed(tools, 'github')).toBe('github_ab12cd')
  expect(serviceNamed(tools, 'notion_ef34ab')).toBe('notion_ef34ab')
  expect(() => serviceNamed(tools, 'linear')).toThrow('No connected service linear. Run spyria to list them.')
  const twice = [...tools, { name: 'github_99ff00-get_me' }]
  expect(() => serviceNamed(twice, 'github')).toThrow('github names several services: github_ab12cd, github_99ff00')
})

test('a service lists its tools by the first sentence of their description, and a tool shows its arguments', () => {
  expect(serviceHelpOf(tools, 'github_ab12cd')).toBe(
    'Tools of github_ab12cd:\n  list_issues  List issues in a GitHub repository.\n  get_me  Who you are\n\nRun spyria github_ab12cd <tool> --help for what a tool takes.',
  )
  const help = toolHelpOf(listIssues)
  expect(help).toContain('  --owner <string>  (required)  Repository owner')
  expect(help).toContain('  --perPage <number>  Results per page.')
  expect(help).toContain('  --state <OPEN | CLOSED>')
})

test('arguments follow the tool’s types, take JSON for lists and --json for all at once, and name what is missing', () => {
  expect(argumentsOf(listIssues, ['--owner', 'acme', '--repo=shop', '--perPage', '20', '--labels', '["bug"]'])).toEqual(
    { owner: 'acme', repo: 'shop', perPage: 20, labels: ['bug'] },
  )
  expect(argumentsOf(listIssues, ['--json', '{"owner":"acme","repo":"shop"}'])).toEqual({ owner: 'acme', repo: 'shop' })
  expect(argumentsOf(search, ['--query', 'roadmap', '--filter', '{"value":"page"}'])).toEqual({
    query: 'roadmap',
    filter: { value: 'page' },
  })
  expect(() => argumentsOf(listIssues, ['--owner', 'acme'])).toThrow('Missing --repo')
  expect(() => argumentsOf(listIssues, ['--owner', 'acme', '--repo', 'shop', '--perPage', 'many'])).toThrow(
    'many is not a number',
  )
  expect(() => argumentsOf(listIssues, ['--owner', 'acme', '--repo', 'shop', '--colour', 'red'])).toThrow(
    'list_issues takes no --colour. Run with --help to see its arguments.',
  )
  expect(() => argumentsOf(listIssues, ['acme'])).toThrow(CommandError)
  expect(() => argumentsOf(search, ['--filter', '{value'])).toThrow('{value is not valid JSON')
})

test('a JSON-RPC answer is read from plain JSON or from the event that carries it', () => {
  const answer = { jsonrpc: '2.0', id: 1, result: { tools: [] } }
  expect(rpcAnswerOf(JSON.stringify(answer))).toEqual(answer)
  expect(
    rpcAnswerOf(
      `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: ${JSON.stringify(answer)}\n\n`,
    ),
  ).toEqual(answer)
})

const calls: { method: string; params: { name?: string; arguments?: unknown }; authorization: string | null }[] = []
const gateway = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const { id, method, params } = await request.json()
    calls.push({ method, params, authorization: request.headers.get('authorization') })
    const result =
      method === 'tools/list'
        ? { tools }
        : method === 'tools/call'
          ? params.arguments.repo === 'secret'
            ? { content: [{ type: 'text', text: 'CRM is off for this chat' }], isError: true }
            : { content: [{ type: 'text', text: '[{"number":7}]' }] }
          : {}
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    })
  },
})
afterAll(() => gateway.stop(true))
const session = { url: `http://127.0.0.1:${gateway.port}/mcp`, token: 'runtime-token' }

test('a tool runs as one call through Spyria with the session’s token, and a refusal comes back as an error', async () => {
  calls.length = 0
  expect(await runSpyriaCommand(['github', 'list_issues', '--owner', 'acme', '--repo', 'shop'], session)).toEqual({
    text: '[{"number":7}]',
    isError: false,
  })
  expect(calls.map(({ method }) => method)).toEqual(['initialize', 'tools/list', 'tools/call'])
  expect(calls.at(-1)?.params).toEqual({
    name: 'github_ab12cd-list_issues',
    arguments: { owner: 'acme', repo: 'shop' },
  })
  expect(new Set(calls.map(({ authorization }) => authorization))).toEqual(new Set(['Bearer runtime-token']))
  expect(await runSpyriaCommand(['github', 'list_issues', '--owner', 'acme', '--repo', 'secret'], session)).toEqual({
    text: 'CRM is off for this chat',
    isError: true,
  })
  expect((await runSpyriaCommand([], session)).text).toStartWith('Connected services:')
  expect((await runSpyriaCommand(['github', 'list_issues', '--help'], session)).text).toContain('--repo <string>')
  expect(calls.filter(({ method }) => method === 'tools/call')).toHaveLength(2)
})

test('a call Spyria does not answer may still have run, and the command says to check before running it again', async () => {
  const answering = globalThis.fetch
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) =>
    String(init?.body).includes('"tools/call"')
      ? Promise.reject(new TypeError('fetch failed'))
      : answering(input, init)) as typeof fetch
  const failure = await runSpyriaCommand(['github', 'get_me'], session).catch((error: unknown) => error)
  globalThis.fetch = answering
  expect(failure).toEqual(
    new CommandError('Spyria did not answer: the call may still have run, so check its effect before running it again'),
  )
})

test('outside a Spyria session the command says so', async () => {
  const refusal = await runSpyriaCommand([], { url: undefined, token: undefined }).catch((error: unknown) => error)
  expect(refusal).toEqual(new CommandError('spyria runs only inside a Spyria session'))
})
