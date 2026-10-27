import { expect, test } from 'bun:test'
import type { WorkspaceId } from '@spyria/kernel'
import { createHttpChatCommands } from './http-chats.ts'

const workspaceId = 'workspace-1' as WorkspaceId
const commandsAnswering = (...statuses: number[]) => {
  const reads: string[] = []
  const getAsMember = async (_workspaceId: WorkspaceId, path: string) => {
    reads.push(path)
    const status = statuses[Math.min(reads.length, statuses.length) - 1] ?? 200
    return status === 200
      ? new Response('image bytes')
      : Response.json(
          { message: status === 404 ? 'This attachment is no longer available' : 'Not allowed' },
          { status },
        )
  }
  return { reads, commands: createHttpChatCommands(async () => new Response(), getAsMember) }
}

test('an attachment of a message the server has not stored yet is read again until it is', async () => {
  const { reads, commands } = commandsAnswering(404, 404, 200)
  const blob = await commands.readMedia({ workspaceId, path: '/api/chats/chat-1/attachments/attachment-1' })
  expect(await blob.text()).toBe('image bytes')
  expect(reads).toHaveLength(3)
})

test('a refused media read fails at once with the server message', async () => {
  const { reads, commands } = commandsAnswering(403)
  const failure = await commands
    .readMedia({ workspaceId, path: '/api/chats/chat-1/attachments/attachment-1' })
    .catch((error: Error) => error.message)
  expect(failure).toBe('Not allowed')
  expect(reads).toHaveLength(1)
})
