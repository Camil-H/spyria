import type { RoutableModel } from '@hq/kernel'
import { Hono } from 'hono'

type FakeLlmStep =
  | { think: string }
  | { command: string }
  | { edit: { path: string; create?: string; oldText?: string; newText?: string } }
  | { plan: { title: string; status: string }[] }
  | { fail: string }
  | { tool: string; arguments?: Record<string, unknown> }
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
}
type CompletionRequest = {
  model?: string
  stream?: boolean
  response_format?: object
  messages?: { role: string }[]
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

const toolCallOf = (step: FakeLlmStep | undefined, offeredTools: readonly string[] = []) => {
  const call =
    !step || 'fail' in step
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
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }
  )
}

const listedModelIds = ['fake-model', 'fake-large', 'fake-medium', 'fake-small', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano']
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
  scriptOf: (request: Request, isClassifier: boolean) => FakeLlmScript | undefined | Promise<FakeLlmScript | undefined>,
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
      const step = request.tools?.length
        ? steps[turnMessages?.filter((message) => message.role === 'assistant').length ?? 0]
        : undefined
      if (step && 'fail' in step)
        return Response.json(
          { type: 'error', error: { type: 'overloaded_error', message: step.fail } },
          { status: 529 },
        )
      const toolCall = toolCallOf(
        step,
        request.tools?.map((tool) => tool.function.name),
      )
      const text = toolCall ? '' : (script.text ?? defaultText)
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
