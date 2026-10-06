import { Hono } from 'hono'

type FakeLlmStep =
  | { think: string }
  | { command: string }
  | { edit: { path: string; create?: string; oldText?: string; newText?: string } }
  | { plan: { title: string; status: string }[] }
  | { fail: string }
export type FakeLlmScript = { text?: string; wordDelayMilliseconds?: number; command?: string; steps?: FakeLlmStep[] }
type CompletionRequest = {
  stream?: boolean
  messages?: { role: string }[]
  tools?: { function: { name: string } }[]
}

const defaultText = 'Understood, working on it.'
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

const toolCallOf = (step: FakeLlmStep | undefined) => {
  const call =
    !step || 'fail' in step
      ? undefined
      : 'think' in step
        ? { name: 'think', arguments: { thought: step.think } }
        : 'command' in step
          ? { name: 'terminal', arguments: { command: step.command, security_risk: 'LOW', summary: step.command } }
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

export const createFakeLlm = (
  scriptOf: (token: string) => FakeLlmScript | undefined | Promise<FakeLlmScript | undefined>,
) =>
  new Hono().post('/v1/chat/completions', async (context) => {
    const request = await context.req.json<CompletionRequest>()
    const script = (await scriptOf(context.req.header('authorization')?.replace(/^Bearer /, '') ?? '')) ?? {}
    const steps = script.steps ?? (script.command ? [{ command: script.command }] : [])
    const turnMessages = request.messages?.slice(request.messages.findLastIndex((message) => message.role === 'user'))
    const step = request.tools?.length
      ? steps[turnMessages?.filter((message) => message.role === 'assistant').length ?? 0]
      : undefined
    if (step && 'fail' in step)
      return context.json({ error: { message: step.fail, type: 'invalid_request_error' } }, 400)
    const toolCall = toolCallOf(step)
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
