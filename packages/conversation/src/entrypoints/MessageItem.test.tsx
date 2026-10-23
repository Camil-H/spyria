import { expect, test } from 'bun:test'
import { messageId } from '@spyria/kernel'
import { prerender } from 'react-dom/static'
import type { ConversationMessage } from '../queries/get-conversation.ts'
import { MessageItem } from './MessageItem.tsx'

const answer: ConversationMessage = {
  id: messageId('message-answer'),
  kind: 'agent',
  authorName: 'Agent',
  createdAt: '2026-10-01T09:00:00.000Z',
  body: 'The **total** is `42`',
  attachments: [],
  step: null,
  replyToId: messageId('message-prompt'),
  canEdit: false,
  isDeleted: false,
  isEdited: false,
  isRunning: true,
  canReply: false,
  thread: null,
  runtimes: [],
}
const htmlOf = async (message: ConversationMessage) => {
  const { prelude } = await prerender(<MessageItem message={message} hasMenu={false} />)
  return new Response(prelude).text()
}

test('a streamed answer shows as plain text, the stored answer as Markdown', async () => {
  const streamed = await htmlOf({ ...answer, id: messageId('streamed-message-prompt'), isStreamed: true })
  expect(streamed).toContain('The **total** is `42`')
  expect(streamed).not.toContain('<strong>')
  const stored = await htmlOf(answer)
  expect(stored).toContain('<strong>total</strong>')
  expect(stored).toContain('<code>42</code>')
})
