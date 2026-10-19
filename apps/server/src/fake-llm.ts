import type { RoutableModel } from '@spyria/kernel'
import { Hono } from 'hono'

type FakeLlmStep = (
  | { think: string }
  | { command: string }
  | { read: string }
  | { edit: { path: string; create?: string; oldText?: string; newText?: string } }
  | { plan: { content: string; status: 'pending' | 'in_progress' | 'completed' }[] }
  | { fail: string }
  | { tool: string; arguments?: Record<string, unknown> }
  | { task: string }
) & { say?: string; hold?: string }
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
  hold?: string
  held?: (name: string) => Promise<unknown>
}
type CompletionRequest = {
  model?: string
  stream?: boolean
  response_format?: object
  messages?: { role: string; content?: unknown }[]
  reasoning_effort?: string
  tools?: { function: { name: string } }[]
}

const defaultText = 'Understood, working on it.'
const unsureRoute: FakeRouteAnswer = { tier: 'medium', confidence: 'low', effort: 'medium' }
const decisionConfidenceOf = (confidence: string | number) =>
  typeof confidence === 'number' ? confidence : confidence === 'high' ? 0.95 : 0.5
const slowRouteMilliseconds = 1_000
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

const piToolCallOf = (step: FakeLlmStep) =>
  'command' in step
    ? { name: 'bash', arguments: { command: step.command } }
    : 'plan' in step
      ? { name: 'update_plan', arguments: { entries: step.plan } }
      : 'read' in step
        ? { name: 'read', arguments: { path: `${workingDirectory}${step.read}` } }
        : 'edit' in step
          ? step.edit.create === undefined
            ? {
                name: 'edit',
                arguments: {
                  path: `${workingDirectory}${step.edit.path}`,
                  edits: [{ oldText: step.edit.oldText, newText: step.edit.newText }],
                },
              }
            : { name: 'write', arguments: { path: `${workingDirectory}${step.edit.path}`, content: step.edit.create } }
          : undefined

const toolCallOf = (step: FakeLlmStep | undefined, offeredTools: readonly string[] = [], taskId = '') => {
  const call =
    !step || 'fail' in step || 'task' in step
      ? undefined
      : 'think' in step
        ? { name: 'think', arguments: { thought: step.think } }
        : 'tool' in step
          ? {
              name: offeredTools.find((name) => name.endsWith(`_${step.tool}`)) ?? step.tool,
              arguments: step.arguments ?? {},
            }
          : piToolCallOf(step)
  return (
    call && {
      index: 0,
      id: `call_${crypto.randomUUID()}`,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments).replace('$taskId', taskId) },
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
  const piCall = step && piToolCallOf(step)
  const call = piCall
    ? { name: piCall.name, input: piCall.arguments }
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
        : undefined
  return call && { type: 'tool_use', id: `toolu_${crypto.randomUUID().replaceAll('-', '')}`, ...call }
}
const anthropicReplyOf = async (request: AnthropicRequest, script: FakeLlmScript) => {
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
  'claude-haiku-5-5',
  'mistral-large-latest',
  'mistral-medium-latest',
  'mistral-small-latest',
  'grok-4.7',
  'grok-4.3',
  'grok-code-fast-1',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'deepseek-v3.2',
  'glm-5.3',
  'glm-4.7',
  'glm-5.3-flash',
  'anthropic/claude-opus-5.5',
  'anthropic/claude-sonnet-5.5',
  'anthropic/claude-haiku-5.5',
  'moonshotai/kimi-k3',
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
          ? { ...chatScript.subagents?.[request.model?.split('/').at(-1) ?? ''], held: chatScript.held }
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
      const isCompacted =
        summary !== undefined &&
        request.messages?.some(
          (message) => message.role === 'user' && JSON.stringify(message.content).includes(summary),
        )
      const step =
        request.tools?.length && !isCompacted
          ? steps[turnMessages?.filter((message) => message.role === 'assistant').length ?? 0]
          : undefined
      if (step && 'fail' in step)
        return Response.json(
          { type: 'error', error: { type: 'overloaded_error', message: step.fail } },
          { status: 529 },
        )
      const taskId = JSON.stringify(request.messages?.findLast((message) => message.role === 'tool') ?? '').match(
        /taskId=\\"([^"\\]+)/,
      )?.[1]
      const toolCall = toolCallOf(
        step,
        request.tools?.map((tool) => tool.function.name),
        taskId,
      )
      const userMessages = String(request.messages?.filter((message) => message.role === 'user').length ?? 0)
      const text = toolCall
        ? (step?.say ?? '')
        : (!request.tools?.length && summary) ||
          (script.text ?? defaultText)
            .replace('$userMessages', userMessages)
            .replace('$reasoningEffort', request.reasoning_effort ?? 'none')
      const reasoning = step && 'think' in step ? step.think : ''
      const finishReason = toolCall ? 'tool_calls' : 'stop'
      const holdName = step?.hold ?? (toolCall ? undefined : script.hold)
      let isHeld = holdName !== undefined
      const holdOnce = async () => {
        if (isHeld) await script.held?.(holdName ?? '')
        isHeld = false
      }
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
              await holdOnce()
            }
          await holdOnce()
          if (toolCall)
            controller.enqueue(eventOf(completionOf({ delta: { tool_calls: [toolCall] }, finish_reason: null })))
          controller.enqueue(eventOf(completionOf({ delta: {}, finish_reason: finishReason }, { usage })))
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
          controller.close()
        },
      })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    })
