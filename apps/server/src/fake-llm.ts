import type { RoutableModel } from '@hq/kernel'
import { Hono } from 'hono'

type FakeLlmStep =
  | { think: string }
  | { command: string }
  | { edit: { path: string; create?: string; oldText?: string; newText?: string } }
  | { plan: { title: string; status: string }[] }
  | { fail: string }
  | { tool: string; arguments?: Record<string, unknown> }
  | { task: string }
type FakeRouteAnswer = { tier: string; confidence: string | number; effort: string; prose?: boolean }
type FakeRoute = FakeRouteAnswer | 'fail' | 'slow'
export type FakeLlmScript = {
  text?: string
  wordDelayMilliseconds?: number
  command?: string
  steps?: FakeLlmStep[]
  route?: FakeRoute
  delegateRoute?: FakeRoute
  subagents?: Record<string, FakeLlmScript>
  summary?: string
}
type CompletionRequest = {
  model?: string
  stream?: boolean
  response_format?: object
  messages?: { role: string; content?: unknown }[]
  tools?: { function: { name: string } }[]
}

const defaultText = 'Understood, working on it.'
const unsureRoute: FakeRouteAnswer = { tier: 'medium', confidence: 'low', effort: 'medium' }
const decisionConfidenceOf = (confidence: string | number) =>
  typeof confidence === 'number' ? confidence : confidence === 'high' ? 0.95 : 0.5
const slowRouteMilliseconds = 5_000
const defaultWordDelayMilliseconds = 30
const workingDirectory = '/workspace/project/'
const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
const completionOf = (choice: object, extra: object = {}) => ({
  id: 'fake',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'fake',
  choices: [{ index: 0, ...choice }],
  ...extra,
})
const eventOf = (data: object) => new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`)
const wordsOf = (text: string) => text.split(/(?<= )/).filter(Boolean)

const toolCallOf = (step: FakeLlmStep | undefined, offeredTools: readonly string[] = [], resumeId = '') => {
  const call =
    !step || 'fail' in step || 'task' in step
      ? undefined
      : 'think' in step
        ? { name: 'think', arguments: { thought: step.think } }
        : 'command' in step
          ? { name: 'terminal', arguments: { command: step.command, security_risk: 'LOW', summary: step.command } }
          : 'tool' in step
            ? {
                name: offeredTools.find((name) => name.endsWith(`_${step.tool}`)) ?? step.tool,
                arguments: step.arguments ?? {},
              }
            : 'plan' in step
              ? {
                  name: 'task_tracker',
                  arguments: { command: 'plan', task_list: step.plan.map((task) => ({ ...task, notes: '' })) },
                }
              : {
                  name: 'file_editor',
                  arguments: {
                    path: `${workingDirectory}${step.edit.path}`,
                    security_risk: 'LOW',
                    ...(step.edit.create === undefined
                      ? { command: 'str_replace', old_str: step.edit.oldText, new_str: step.edit.newText }
                      : { command: 'create', file_text: step.edit.create }),
                  },
                }
  return (
    call && {
      index: 0,
      id: `call_${crypto.randomUUID()}`,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments).replace('$resume', resumeId) },
    }
  )
}

type AnthropicBlock = { type: string; text?: string }
type AnthropicRequest = {
  stream?: boolean
  system?: unknown
  messages?: { role: string; content: string | AnthropicBlock[] }[]
  tools?: { name: string }[]
}
type AnthropicTurn = { thinking: string[]; step?: FakeLlmStep }
const anthropicUsage = { input_tokens: 1, output_tokens: 1 }
const typedEventOf = (data: { type: string; [field: string]: unknown }) =>
  new TextEncoder().encode(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)
const promptTextOf = (content: string | AnthropicBlock[]) =>
  (typeof content === 'string'
    ? content
    : content.map((block) => (block.type === 'text' || block.type === 'input_text' ? block.text : '')).join('')
  )
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .trim()
const anthropicTurnsOf = (steps: readonly FakeLlmStep[]) => {
  const turns: AnthropicTurn[] = [{ thinking: [] }]
  for (const step of steps) {
    const turn = turns.at(-1) as AnthropicTurn
    if ('think' in step) turn.thinking.push(step.think)
    else {
      turn.step = step
      turns.push({ thinking: [] })
    }
  }
  return turns
}
const toolUseOf = (step: FakeLlmStep | undefined, offeredTools: readonly string[], prompt: string) => {
  const call =
    step && 'command' in step
      ? { name: 'Bash', input: { command: step.command, description: step.command } }
      : step && 'tool' in step
        ? {
            name: offeredTools.find((name) => name.endsWith(`_${step.tool}`)) ?? step.tool,
            input: step.arguments ?? {},
          }
        : step && 'task' in step
          ? {
              name: offeredTools.find((name) => name === 'Agent' || name === 'Task') ?? 'Agent',
              input: { description: step.task, prompt: `${step.task}\n\n${prompt}`, subagent_type: 'general-purpose' },
            }
          : step && 'edit' in step
            ? {
                name: 'Write',
                input: { file_path: `${workingDirectory}${step.edit.path}`, content: step.edit.create ?? '' },
              }
            : undefined
  return call && { type: 'tool_use', id: `toolu_${crypto.randomUUID().replaceAll('-', '')}`, ...call }
}
const anthropicReplyOf = async (request: AnthropicRequest, chatScript: FakeLlmScript) => {
  const isSubagent = JSON.stringify(request.system ?? '').includes('cc_is_subagent=true')
  const script = (isSubagent ? chatScript.subagents?.task : chatScript) ?? {}
  const messages = request.messages ?? []
  const promptIndex = messages.findLastIndex((message) => message.role === 'user' && promptTextOf(message.content))
  const answeredSteps = messages.slice(promptIndex).filter((message) => message.role === 'assistant').length
  const steps = script.steps ?? (script.command ? [{ command: script.command }] : [])
  const turn = (request.tools?.length && anthropicTurnsOf(steps)[answeredSteps]) || { thinking: [] }
  if (turn.step && 'fail' in turn.step)
    return Response.json(
      { type: 'error', error: { type: 'overloaded_error', message: turn.step.fail } },
      { status: 529 },
    )
  const toolUse = toolUseOf(
    turn.step,
    (request.tools ?? []).map((tool) => tool.name),
    promptTextOf(messages[promptIndex]?.content ?? ''),
  )
  const thinking = turn.thinking.join(' ')
  const text = script.text ?? defaultText
  const blocks = [
    ...(thinking
      ? [
          {
            start: { type: 'thinking', thinking: '', signature: '' },
            whole: { type: 'thinking', thinking, signature: 'fake' },
            deltas: [
              { type: 'thinking_delta', thinking },
              { type: 'signature_delta', signature: 'fake' },
            ],
          },
        ]
      : []),
    toolUse
      ? {
          start: { ...toolUse, input: {} },
          whole: toolUse,
          deltas: [{ type: 'input_json_delta', partial_json: JSON.stringify(toolUse.input) }],
        }
      : {
          start: { type: 'text', text: '' },
          whole: { type: 'text', text },
          deltas: wordsOf(text).map((word) => ({ type: 'text_delta', text: word })),
        },
  ]
  const stopReason = toolUse ? 'tool_use' : 'end_turn'
  const message = { id: `msg_${crypto.randomUUID()}`, type: 'message', role: 'assistant', model: 'fake' }
  const ending = { stop_reason: stopReason, stop_sequence: null }
  if (!request.stream)
    return Response.json({ ...message, content: blocks.map(({ whole }) => whole), ...ending, usage: anthropicUsage })
  const stream = new ReadableStream({
    start: async (controller) => {
      const send = (data: Parameters<typeof typedEventOf>[0]) => controller.enqueue(typedEventOf(data))
      send({ type: 'message_start', message: { ...message, content: [], usage: anthropicUsage } })
      for (const [index, block] of blocks.entries()) {
        send({ type: 'content_block_start', index, content_block: block.start })
        for (const delta of block.deltas) {
          await Bun.sleep(script.wordDelayMilliseconds ?? defaultWordDelayMilliseconds)
          send({ type: 'content_block_delta', index, delta })
        }
        send({ type: 'content_block_stop', index })
      }
      send({ type: 'message_delta', delta: ending, usage: anthropicUsage })
      send({ type: 'message_stop' })
      controller.close()
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
}

type ResponsesRequest = {
  stream?: boolean
  input?: { type?: string; role?: string; content?: string | AnthropicBlock[] }[]
}
const responsesUsage = {
  input_tokens: 1,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 1,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 2,
}
const execCodeOf = (step: FakeLlmStep | undefined) => {
  const call =
    step && 'command' in step
      ? `exec_command(${JSON.stringify({ cmd: step.command })})`
      : step && 'tool' in step
        ? `mcp__hq__${step.tool.replace(/\W/g, '_')}(${JSON.stringify(step.arguments ?? {})})`
        : undefined
  return call && `text(JSON.stringify(await tools.${call}))`
}
const responsesReplyOf = async (request: ResponsesRequest, script: FakeLlmScript) => {
  const input = request.input ?? []
  const promptIndex = input.findLastIndex((item) => item.role === 'user')
  const answeredSteps = input.slice(promptIndex).filter((item) => item.type === 'custom_tool_call').length
  const steps = script.steps ?? (script.command ? [{ command: script.command }] : [])
  const hasTools = input.some((item) => item.type === 'additional_tools')
  const turn = (hasTools && anthropicTurnsOf(steps)[answeredSteps]) || { thinking: [] }
  if (turn.step && 'fail' in turn.step)
    return Response.json({ error: { type: 'overloaded_error', message: turn.step.fail } }, { status: 529 })
  const code = execCodeOf(turn.step)
  const id = crypto.randomUUID().replaceAll('-', '')
  const text = script.text ?? defaultText
  const thinking = turn.thinking.join(' ')
  const output = [
    ...(thinking ? [{ id: `rs_${id}`, type: 'reasoning', summary: [{ type: 'summary_text', text: thinking }] }] : []),
    code
      ? {
          id: `ctc_${id}`,
          type: 'custom_tool_call',
          status: 'completed',
          call_id: `call_${id}`,
          name: 'exec',
          input: code,
        }
      : {
          id: `msg_${id}`,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
  ]
  const response = { id: `resp_${id}`, object: 'response', status: 'completed', model: 'fake', output }
  if (!request.stream) return Response.json({ ...response, usage: responsesUsage })
  const stream = new ReadableStream({
    start: async (controller) => {
      const send = (data: Parameters<typeof typedEventOf>[0]) => controller.enqueue(typedEventOf(data))
      send({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } })
      for (const [index, item] of output.entries()) {
        send({
          type: 'response.output_item.added',
          output_index: index,
          item: item.type === 'message' ? { ...item, content: [] } : item,
        })
        for (const word of item.type === 'message' ? wordsOf(text) : []) {
          await Bun.sleep(script.wordDelayMilliseconds ?? defaultWordDelayMilliseconds)
          send({
            type: 'response.output_text.delta',
            item_id: item.id,
            output_index: index,
            content_index: 0,
            delta: word,
          })
        }
        send({ type: 'response.output_item.done', output_index: index, item })
      }
      send({ type: 'response.completed', response: { ...response, usage: responsesUsage } })
      controller.close()
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
}

const listedModelIds = [
  'fake-model',
  'fake-large',
  'fake-medium',
  'fake-small',
  'gpt-5',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-6.1-sol',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-4-5',
]
export const fakeRoutableModels: RoutableModel[] = [
  { id: 'fake/fake-large', name: 'Fake large', tier: 'large' },
  { id: 'fake/fake-medium', name: 'Fake medium', tier: 'medium' },
  { id: 'fake/fake-small', name: 'Fake small', tier: 'small' },
  { id: 'fake-small/fake-small', name: 'Fake small', tier: 'small' },
]

const refusedKeyOf = (key: string) => ({
  error: {
    message: `Incorrect API key provided: ${key.slice(0, 3)}****${key.slice(-4)}.`,
    type: 'invalid_request_error',
    param: null,
    code: 'invalid_api_key',
  },
})

const routeOf = async (route: FakeRoute = unsureRoute) => {
  if (route === 'fail') return undefined
  if (route === 'slow') await Bun.sleep(slowRouteMilliseconds)
  return route === 'slow' ? unsureRoute : route
}
const classifierDownOf = { error: { message: 'Classifier down', type: 'server_error' } }
const scriptedRouteOf = (script: FakeLlmScript | undefined, request: object) =>
  JSON.stringify(request).includes('Subagent task') ? script?.delegateRoute : script?.route
const isSubagentCall = (request: CompletionRequest, script: FakeLlmScript) => {
  const firstPrompt = JSON.stringify(request.messages?.find((message) => message.role === 'user') ?? '')
  return (script.steps ?? []).some(
    (step) => 'tool' in step && step.tool === 'delegate' && firstPrompt.includes(String(step.arguments?.task)),
  )
}

export const createFakeLlm = (
  scriptOf: (
    request: Request,
    isClassifier: boolean,
    prompt?: string,
  ) => FakeLlmScript | undefined | Promise<FakeLlmScript | undefined>,
) =>
  new Hono()
    .get('/v1/models', (context) =>
      context.json({
        object: 'list',
        data: listedModelIds.map((id) => ({
          id,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'fake',
        })),
      }),
    )
    .post('/v1/messages/count_tokens', async (context) =>
      (await context.req.text()).includes('$count-fails')
        ? context.json({ type: 'error', error: { type: 'api_error', message: 'Counting failed' } }, 500)
        : context.json({ input_tokens: 1 }),
    )
    .post('/v1/messages', async (context) => {
      const request = await context.req.json<AnthropicRequest>()
      const prompt = request.messages?.findLast((message) => message.role === 'user' && promptTextOf(message.content))
      return anthropicReplyOf(
        request,
        (await scriptOf(context.req.raw, false, prompt && promptTextOf(prompt.content))) ?? {},
      )
    })
    .post('/v1/responses', async (context) => {
      const request = await context.req.json<ResponsesRequest>()
      const prompt = request.input?.findLast((item) => item.role === 'user')?.content
      return responsesReplyOf(request, (await scriptOf(context.req.raw, false, prompt && promptTextOf(prompt))) ?? {})
    })
    .post('/v1/systemone', async (context) => {
      const route = await routeOf(scriptedRouteOf(await scriptOf(context.req.raw, true), await context.req.json()))
      if (!route) return context.json(classifierDownOf, 500)
      const confidence = decisionConfidenceOf(route.confidence)
      return context.json({
        answers: {
          tier: { type: 'choice', choice: route.tier, confidence },
          effort: { type: 'choice', choice: route.effort, confidence },
        },
        usage: { input_tokens: 40, output_tokens: 0 },
      })
    })
    .post('/v1/chat/completions', async (context) => {
      const key = context.req.header('authorization')?.replace(/^Bearer /, '') ?? ''
      if (key.includes('refused')) return context.json(refusedKeyOf(key), 401)
      const request = await context.req.json<CompletionRequest>()
      if (JSON.stringify(request.messages).includes('$too-long'))
        return context.json(
          {
            type: 'error',
            error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum' },
          },
          400,
        )
      const chatScript = (await scriptOf(context.req.raw, Boolean(request.response_format))) ?? {}
      const script =
        !request.response_format && isSubagentCall(request, chatScript)
          ? (chatScript.subagents?.[request.model?.split('/').at(-1) ?? ''] ?? {})
          : chatScript
      if (request.response_format) {
        const route = await routeOf(scriptedRouteOf(script, request))
        if (!route) return context.json(classifierDownOf, 500)
        const { prose, ...fields } = route
        const json = JSON.stringify({ ...fields, reason: 'fake classification' })
        const answer = prose ? `Here is my routing decision: ${json} Let me know if you need more.` : json
        return context.json({
          ...completionOf({ message: { role: 'assistant', content: answer }, finish_reason: 'stop' }, { usage }),
          object: 'chat.completion',
        })
      }
      const steps = script.steps ?? (script.command ? [{ command: script.command }] : [])
      const turnMessages = request.messages?.slice(request.messages.findLastIndex((message) => message.role === 'user'))
      const { summary } = chatScript
      const isCondensed =
        summary !== undefined &&
        request.messages?.some(
          (message) => message.role === 'user' && JSON.stringify(message.content).includes(summary),
        )
      const step =
        request.tools?.length && !isCondensed
          ? steps[turnMessages?.filter((message) => message.role === 'assistant').length ?? 0]
          : undefined
      if (step && 'fail' in step)
        return Response.json(
          { type: 'error', error: { type: 'overloaded_error', message: step.fail } },
          { status: 529 },
        )
      const resumeId = JSON.stringify(request.messages?.findLast((message) => message.role === 'tool') ?? '').match(
        /resume=\\"([^"\\]+)/,
      )?.[1]
      const toolCall = toolCallOf(
        step,
        request.tools?.map((tool) => tool.function.name),
        resumeId,
      )
      const text = toolCall ? '' : (!request.tools?.length && summary) || (script.text ?? defaultText)
      const reasoning = step && 'think' in step ? step.think : ''
      const finishReason = toolCall ? 'tool_calls' : 'stop'
      if (!request.stream)
        return context.json({
          ...completionOf(
            {
              message: { role: 'assistant', content: text, ...(toolCall && { tool_calls: [toolCall] }) },
              finish_reason: finishReason,
            },
            { usage },
          ),
          object: 'chat.completion',
        })
      const stream = new ReadableStream({
        start: async (controller) => {
          controller.enqueue(eventOf(completionOf({ delta: { role: 'assistant', content: '' }, finish_reason: null })))
          for (const [field, words] of [
            ['reasoning_content', wordsOf(reasoning)],
            ['content', wordsOf(text)],
          ] as const)
            for (const word of words) {
              await Bun.sleep(script.wordDelayMilliseconds ?? defaultWordDelayMilliseconds)
              controller.enqueue(eventOf(completionOf({ delta: { [field]: word }, finish_reason: null })))
            }
          if (toolCall)
            controller.enqueue(eventOf(completionOf({ delta: { tool_calls: [toolCall] }, finish_reason: null })))
          controller.enqueue(eventOf(completionOf({ delta: {}, finish_reason: finishReason }, { usage })))
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
          controller.close()
        },
      })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    })
