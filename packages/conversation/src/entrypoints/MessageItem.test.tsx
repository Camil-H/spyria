import { expect, test } from 'bun:test'
import { messageId } from '@spyria/kernel'
import { prerender } from 'react-dom/static'
import { MemoryRouter } from 'react-router'
import type { ConversationMessage } from '../queries/get-conversation.ts'
import { MessageItem } from './MessageItem.tsx'
import { MentionNamesContext } from './providers.tsx'

const answer: ConversationMessage = {
  id: messageId('message-answer'),
  kind: 'agent',
  authorName: 'Agent',
  authorAvatar: null,
  createdAt: new Date('2026-10-01T09:00:00.000Z'),
  body: 'The **total** is `42`',
  attachments: [],
  step: null,
  replyToId: messageId('message-prompt'),
  canEdit: false,
  isDeleted: false,
  isEdited: false,
  isRunning: true,
  canReply: false,
  canQuote: false,
  quote: null,
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

test('a stored message bolds the mentions of the member names its chat provides', async () => {
  const mention = { ...answer, kind: 'member' as const, body: 'Thanks @Bob and @Zoe' }
  const { prelude } = await prerender(
    <MentionNamesContext value={['Alice', 'Bob']}>
      <MessageItem message={mention} hasMenu={false} />
    </MentionNamesContext>,
  )
  const html = await new Response(prelude).text()
  expect(html).toContain('<strong>@Bob</strong>')
  expect(html).not.toContain('<strong>@Zoe</strong>')
})

test('a reply links to the message it quotes, with its author and text, a deleted one as deleted, one not loaded as earlier', async () => {
  const reply = async (original: NonNullable<ConversationMessage['quote']>['original']) => {
    const { prelude } = await prerender(
      <MemoryRouter>
        <MessageItem message={{ ...answer, quote: { id: messageId('message-quoted'), original } }} hasMenu={false} />
      </MemoryRouter>,
    )
    return new Response(prelude).text()
  }
  const shown = await reply({ authorName: 'Bob', body: 'Welcome to the team!', isDeleted: false })
  expect(shown).toContain('href="/?message=message-quoted"')
  expect(shown).toMatch(/In reply to <\/span>.*Bob<\/span> <span[^>]*>Welcome to the team!<\/span>/)
  expect(await reply({ authorName: 'Bob', body: '', isDeleted: true })).toContain('This message was deleted')
  expect(await reply(null)).toContain('an earlier message')
})
