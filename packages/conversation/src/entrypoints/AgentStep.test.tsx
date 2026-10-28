import { expect, test } from 'bun:test'
import { messageId } from '@spyria/kernel'
import { prerender } from 'react-dom/static'
import type { AgentStep as Step } from '../domain/agent-steps.ts'
import type { ConversationMessage } from '../queries/get-conversation.ts'
import { AgentStep } from './AgentStep.tsx'
import type { AgentStream, ConversationCommands } from './commands.ts'
import { ConversationProvider } from './providers.tsx'

const stepMessageOf = (step: Step): ConversationMessage => ({
  id: messageId('message-step'),
  kind: 'step',
  authorName: 'Agent',
  authorAvatar: null,
  createdAt: '2026-10-01T09:00:00.000Z',
  body: 'tool',
  attachments: [],
  step,
  replyToId: messageId('message-prompt'),
  canEdit: false,
  isDeleted: false,
  isEdited: false,
  isRunning: true,
  canReply: false,
  thread: null,
  runtimes: [],
})
const htmlOf = async (step: Step) => {
  const { prelude } = await prerender(
    <ConversationProvider commands={{} as ConversationCommands} agentStream={{} as AgentStream}>
      <AgentStep message={stepMessageOf(step)} />
    </ConversationProvider>,
  )
  return new Response(prelude).text()
}

test.each(['{}', ''])('a tool call whose input is %p shows only the tool it used', async (toolArguments) => {
  const html = await htmlOf({ type: 'tool', name: 'Task', arguments: toolArguments, result: null })
  expect(html).not.toContain('{}')
  expect(html).not.toContain('aria-expanded')
  expect(html).toContain('Used Task')
})

test('a tool call with an input shows it next to the tool it used', async () => {
  const html = await htmlOf({ type: 'tool', name: 'Task', arguments: '{"description":"Explore"}', result: null })
  expect(html).toContain('Used Task')
  expect(html).toContain('{&quot;description&quot;:&quot;Explore&quot;}')
  expect(html).toContain('aria-expanded')
})
