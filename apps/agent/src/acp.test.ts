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
    { command: ['sh', '-c', `read request; printf '%s\\n' '${answerThenUpdate}'; exec sleep 5`], env: {}, cwd: '/' },
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

test('an adapter that exits in the same read as its answers delivers them, and the update behind them, before it exits', async () => {
  const delivered: string[] = []
  const exited = Promise.withResolvers<void>()
  const connection = connectAdapter(
    { command: [], env: {}, cwd: '/' },
    {
      onUpdate: () => void delivered.push('update'),
      onExit: () => {
        delivered.push('exit')
        exited.resolve()
      },
      onRequest: () => undefined,
      onCancelRequest: () => {},
    },
    (_, onRecord, onExit) => {
      let written = 0
      return {
        hasExited: false,
        write: () => {
          written++
          if (written < 2) return
          onRecord({ jsonrpc: '2.0', id: 0, result: { answered: 0 } })
          onRecord({ jsonrpc: '2.0', method: 'session/update', params: { update: {} } })
          onRecord({ jsonrpc: '2.0', id: 1, result: { answered: 1 } })
          onExit(0)
        },
        errorOutput: () => [],
        closed: Promise.resolve(),
        close: () => true,
      }
    },
  )
  const answered = (method: string) =>
    connection.request(method, {}).then(
      (result) => void delivered.push(`answer ${result.answered}`),
      () => void delivered.push(`${method} refused`),
    )
  await Promise.all([answered('first'), answered('second'), exited.promise])
  expect(delivered).toEqual(['answer 0', 'update', 'answer 1', 'exit'])
})
