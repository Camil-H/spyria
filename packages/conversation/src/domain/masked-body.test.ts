import { expect, test } from 'bun:test'
import { clearedOutput, maskedBody } from './masked-body.ts'

const longText = (index: number) => `output ${index} `.repeat(200)
const filler = 'x'.repeat(400_000)
type Message = { role: string; content?: unknown; name?: string; tool_call_id?: string; tool_calls?: object[] }

const conversationOf = (outputs: { name?: string; text?: string }[], prompt = filler) => {
  const messages: Message[] = [
    { role: 'system', content: [{ type: 'text', text: 'You are an agent.' }] },
    { role: 'user', content: [{ type: 'text', text: prompt }] },
  ]
  outputs.forEach(({ name = 'terminal', text }, index) => {
    const id = `call_${index}`
    messages.push(
      { role: 'assistant', tool_calls: [{ id, type: 'function', function: { name, arguments: `{"step":${index}}` } }] },
      { role: 'tool', tool_call_id: id, name, content: [{ type: 'text', text: text ?? longText(index) }] },
    )
  })
  return JSON.stringify({ model: 'fake/fake-medium', stream: true, messages, tools: [] })
}
const terminalOutputs = (count: number) => Array.from({ length: count }, () => ({}))
const messagesOf = (body: string) => (JSON.parse(body) as { messages: Message[] }).messages
const outputsOf = (body: string) => messagesOf(body).filter((message) => message.role === 'tool')
const isCleared = (message: Message | undefined) => message?.content === clearedOutput

test('below the trigger, the body is forwarded unchanged', () => {
  const body = conversationOf(terminalOutputs(40), 'short prompt')
  expect(maskedBody(body)).toBe(body)
})

test('above the trigger, old long outputs are cleared while calls, arguments, order and kept outputs stay', () => {
  const outputs = [
    { name: 'task_tracker' },
    { name: 'router_delegate' },
    { text: 'short output' },
    ...terminalOutputs(27),
    { name: 'task_tracker' },
  ]
  const body = conversationOf(outputs)
  const masked = maskedBody(body)
  const original = messagesOf(body)
  const rewritten = messagesOf(masked)

  expect(
    rewritten.map(({ role, tool_calls, tool_call_id, name }) => ({ role, tool_calls, tool_call_id, name })),
  ).toEqual(original.map(({ role, tool_calls, tool_call_id, name }) => ({ role, tool_calls, tool_call_id, name })))
  const cleared = outputsOf(masked).map(isCleared)
  expect(cleared.slice(0, 3)).toEqual([false, false, false])
  expect(cleared.slice(3, 20)).toEqual(Array(17).fill(true))
  expect(cleared.slice(20)).toEqual(Array(11).fill(false))
  expect(outputsOf(masked).slice(20)).toEqual(outputsOf(body).slice(20))
})

test('the cutoff moves in batches of 20 outputs, so requests with 31 to 49 outputs share the same masked prefix', () => {
  const clearedCountOf = (count: number) =>
    outputsOf(maskedBody(conversationOf(terminalOutputs(count)))).filter(isCleared)
  expect(clearedCountOf(30)).toHaveLength(20)
  for (const count of [31, 40, 49]) expect(clearedCountOf(count)).toHaveLength(20)
  expect(clearedCountOf(50)).toHaveLength(40)

  const messagesTextOf = (count: number) =>
    JSON.stringify(messagesOf(maskedBody(conversationOf(terminalOutputs(count)))))
  const prefixAt31 = messagesTextOf(31).slice(0, -1)
  expect(messagesTextOf(49).startsWith(prefixAt31)).toBe(true)
  expect(messagesTextOf(50).startsWith(prefixAt31)).toBe(false)
})
