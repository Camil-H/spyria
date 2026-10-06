import { Hono } from 'hono'

export type FakeLlmScript = { text?: string; wordDelayMilliseconds?: number; command?: string }
type CompletionRequest = {
  stream?: boolean
  messages?: { role: string }[]
  tools?: { function: { name: string } }[]
}

const defaultText = 'Understood, working on it.'
const defaultWordDelayMilliseconds = 30
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

export const createFakeLlm = (
  scriptOf: (token: string) => FakeLlmScript | undefined | Promise<FakeLlmScript | undefined>,
) =>
  new Hono().post('/v1/chat/completions', async (context) => {
    const request = await context.req.json<CompletionRequest>()
    const script = (await scriptOf(context.req.header('authorization')?.replace(/^Bearer /, '') ?? '')) ?? {}
    const canRunCommand = request.tools?.some((tool) => tool.function.name === 'terminal')
    const command = canRunCommand && request.messages?.at(-1)?.role !== 'tool' ? script.command : undefined
    const toolCall = command && {
      index: 0,
      id: 'call_fake',
      type: 'function',
      function: { name: 'terminal', arguments: JSON.stringify({ command, security_risk: 'LOW', summary: command }) },
    }
    const text = toolCall ? '' : (script.text ?? defaultText)
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
        for (const word of text.split(/(?<= )/).filter(Boolean)) {
          await Bun.sleep(script.wordDelayMilliseconds ?? defaultWordDelayMilliseconds)
          controller.enqueue(eventOf(completionOf({ delta: { content: word }, finish_reason: null })))
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
