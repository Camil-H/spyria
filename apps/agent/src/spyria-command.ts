type JsonSchema = {
  type?: string | string[]
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
}
export type Tool = { name: string; description?: string; inputSchema?: JsonSchema }
type ToolResult = { content?: { type?: string; text?: string }[]; isError?: boolean }
type Rpc = { result?: unknown; error?: { message?: string } }

export class CommandError extends Error {}

const usage = `Usage:
  spyria                          list the connected services
  spyria <service>                list the tools of a service
  spyria <service> <tool> --help  show what a tool takes
  spyria <service> <tool> [--<argument> <value>]... [--json '<arguments as JSON>']`

const firstSentenceOf = (text = '') => text.split(/(?<=\.)\s|\n/)[0]?.trim() ?? ''
const serverOf = (toolName: string) => toolName.slice(0, toolName.indexOf('-'))
const toolOf = (toolName: string) => toolName.slice(toolName.indexOf('-') + 1)

export const servicesOf = (tools: readonly Tool[]) => {
  const counts = new Map<string, number>()
  for (const { name } of tools.filter((tool) => tool.name.includes('-')))
    counts.set(serverOf(name), (counts.get(serverOf(name)) ?? 0) + 1)
  return [...counts].map(([name, count]) => ({ name, count }))
}

export const serviceNamed = (tools: readonly Tool[], asked: string) => {
  const names = servicesOf(tools).map(({ name }) => name)
  if (names.includes(asked)) return asked
  const matches = names.filter((name) => name.replace(/_[0-9a-f]{6}$/, '') === asked.toLowerCase())
  if (matches.length === 1) return matches[0] as string
  throw new CommandError(
    matches.length > 1
      ? `${asked} names several services: ${matches.join(', ')}`
      : `No connected service ${asked}. Run spyria to list them.`,
  )
}

export const servicesHelpOf = (tools: readonly Tool[]) => {
  const services = servicesOf(tools)
  const listed = services.map(({ name, count }) => `  ${name}  ${count} tool${count === 1 ? '' : 's'}`).join('\n')
  return `${services.length > 0 ? `Connected services:\n${listed}` : 'No connected service is available to you in this chat.'}\n\n${usage}`
}

export const serviceHelpOf = (tools: readonly Tool[], service: string) =>
  [
    `Tools of ${service}:`,
    ...tools
      .filter(({ name }) => serverOf(name) === service)
      .map(({ name, description }) => `  ${toolOf(name)}  ${firstSentenceOf(description)}`),
    '',
    `Run spyria ${service} <tool> --help for what a tool takes.`,
  ].join('\n')

const typeOf = (schema: JsonSchema) => (Array.isArray(schema.type) ? schema.type.join(' | ') : (schema.type ?? 'any'))

export const toolHelpOf = (tool: Tool) => {
  const { properties = {}, required = [] } = tool.inputSchema ?? {}
  const argumentLines = Object.entries(properties).map(([name, schema]) =>
    [
      `  --${name} <${schema.enum ? schema.enum.join(' | ') : typeOf(schema)}>`,
      required.includes(name) ? '(required)' : '',
      firstSentenceOf(schema.description),
    ]
      .filter(Boolean)
      .join('  '),
  )
  return [
    tool.description?.trim() ?? '',
    '',
    argumentLines.length > 0 ? `Arguments:\n${argumentLines.join('\n')}` : 'No arguments.',
    '',
    'Objects and lists take JSON, for example --labels \'["bug"]\'. --json passes all arguments at once.',
  ].join('\n')
}

const jsonArgumentOf = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    throw new CommandError(`${text} is not valid JSON`)
  }
}

const argumentValueOf = (schema: JsonSchema | undefined, text: string): unknown => {
  const types = [schema?.type ?? []].flat()
  if (types.includes('string') || types.length === 0) {
    if (types.length === 0 && /^[[{]/.test(text)) return jsonArgumentOf(text)
    return text
  }
  if (types.includes('integer') || types.includes('number')) {
    const number = Number(text)
    if (Number.isNaN(number)) throw new CommandError(`${text} is not a number`)
    return number
  }
  if (types.includes('boolean')) {
    if (text !== 'true' && text !== 'false') throw new CommandError(`${text} is not true or false`)
    return text === 'true'
  }
  return jsonArgumentOf(text)
}

export const argumentsOf = (tool: Tool, words: readonly string[]) => {
  const properties = tool.inputSchema?.properties ?? {}
  const given: Record<string, unknown> = {}
  const remaining = [...words]
  while (remaining.length > 0) {
    const word = remaining.shift() as string
    if (!word.startsWith('--')) throw new CommandError(`Unexpected ${word}: arguments are --<name> <value>`)
    const [name = '', inlineValue] = word.slice(2).split(/=(.*)/s)
    const text = inlineValue ?? remaining.shift()
    if (text === undefined) throw new CommandError(`--${name} needs a value`)
    if (name === 'json') Object.assign(given, argumentValueOf({ type: 'object' }, text))
    else if (name in properties || Object.keys(properties).length === 0)
      given[name] = argumentValueOf(properties[name], text)
    else throw new CommandError(`${toolOf(tool.name)} takes no --${name}. Run with --help to see its arguments.`)
  }
  const missing = (tool.inputSchema?.required ?? []).filter((name) => !(name in given))
  if (missing.length > 0) throw new CommandError(`Missing ${missing.map((name) => `--${name}`).join(', ')}`)
  return given
}

export const rpcAnswerOf = (text: string): Rpc => {
  const data = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
  const messages = (data.length > 0 ? data : [text]).flatMap((part) => {
    try {
      return [JSON.parse(part) as Rpc]
    } catch {
      return []
    }
  })
  return messages.find((message) => 'result' in message || 'error' in message) ?? {}
}

export const textOf = (result: ToolResult) =>
  (result.content ?? [])
    .map((part) => (part.type === 'text' || part.text !== undefined ? part.text : `[${part.type}]`))
    .join('\n')

const callGateway = async (url: string, token: string, method: string, params: object) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).catch(() => undefined)
  if (!response)
    throw new CommandError(
      method === 'tools/call'
        ? 'Spyria did not answer: the call may still have run, so check its effect before running it again'
        : 'Spyria is unreachable from here, try again shortly',
    )
  const answer = rpcAnswerOf(await response.text())
  if (!response.ok || answer.error)
    throw new CommandError(answer.error?.message ?? `Spyria answered ${response.status}`)
  return answer.result
}

export const runSpyriaCommand = async (
  words: readonly string[],
  { url, token }: { url: string | undefined; token: string | undefined },
) => {
  if (!url || !token) throw new CommandError('spyria runs only inside a Spyria session')
  await callGateway(url, token, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'spyria-command', version: '1' },
  })
  const { tools = [] } = ((await callGateway(url, token, 'tools/list', {})) ?? {}) as { tools?: Tool[] }
  const [asked, toolName, ...rest] = words
  if (!asked || asked === '--help' || asked === '-h') return { text: servicesHelpOf(tools), isError: false }
  const service = serviceNamed(tools, asked)
  if (!toolName || toolName === '--help' || toolName === '-h')
    return { text: serviceHelpOf(tools, service), isError: false }
  const tool = tools.find(({ name }) => name === `${service}-${toolName}`)
  if (!tool) throw new CommandError(`${service} has no tool ${toolName}. Run spyria ${service} to list them.`)
  if (rest.includes('--help') || rest.includes('-h')) return { text: toolHelpOf(tool), isError: false }
  const result = (await callGateway(url, token, 'tools/call', {
    name: tool.name,
    arguments: argumentsOf(tool, rest),
  })) as ToolResult
  return { text: textOf(result ?? {}), isError: result?.isError === true }
}

if (import.meta.main) {
  const outcome = await runSpyriaCommand(process.argv.slice(2), {
    url: process.env.SPYRIA_TOOLS_URL,
    token: process.env.SPYRIA_MCP_TOKEN,
  }).catch((error: unknown) => {
    if (!(error instanceof CommandError)) throw error
    return { text: error.message, isError: true }
  })
  ;(outcome.isError ? process.stderr : process.stdout).write(`${outcome.text}\n`)
  process.exitCode = outcome.isError ? 1 : 0
}
