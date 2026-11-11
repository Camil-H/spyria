import { expect, test } from 'bun:test'
import { connectAdapter } from './acp.ts'

const answerThenUpdate = [
  JSON.stringify({ jsonrpc: '2.0', id: 0, result: { stopReason: 'end_turn' } }),
  JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'next turn' } } },
  }),
].join('\n')

test('an answer read together with the next update settles before that update is delivered', async () => {
  const delivered: string[] = []
  const updated = Promise.withResolvers<void>()
  const connection = connectAdapter(
    { command: ['sh', '-c', `read request; printf '%s\\n' '${answerThenUpdate}'; sleep 5`], env: {}, cwd: '/' },
    {
      onUpdate: () => {
        delivered.push('update')
        updated.resolve()
      },
      onExit: () => {},
      onRequest: () => undefined,
      onCancelRequest: () => {},
    },
  )
  const settled = async () => {
    await connection.request('session/prompt', {})
    await Promise.resolve()
    await Promise.resolve()
    delivered.push('answer')
  }
  await Promise.all([settled(), updated.promise])
  connection.close()
  expect(delivered).toEqual(['answer', 'update'])
})
