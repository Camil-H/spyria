import { expect, test } from 'bun:test'
import { MessageBody } from './message-body.ts'
import { agentPromptTextOf, type QuotedMessage, threadWrapperOf } from './thread-wrapper.ts'

const quoted = (
  authorName: string,
  body: string,
  time: string,
  fields: Partial<QuotedMessage> = {},
): QuotedMessage => ({
  authorName,
  kind: 'member',
  body: MessageBody(body),
  createdAt: new Date(`2026-10-17T${time}:00.000Z`),
  deletedAt: null,
  ...fields,
})

test('the wrapper quotes each message with its author, kind and UTC time, a blank line between', () => {
  expect(
    String(
      threadWrapperOf('Welcome', [
        quoted('Alice', 'Can we ship the invoice fix?', '09:05'),
        quoted('Agent', 'The tests pass.\nReady.', '09:07', { kind: 'agent' }),
        quoted('Bob', 'Yes, after review.', '14:30'),
      ]),
    ),
  ).toBe(
    [
      'Conversation so far, from the channel thread in #Welcome:',
      '',
      'Alice (member, human) · 2026-10-17 09:05 UTC',
      'Can we ship the invoice fix?',
      '',
      'Agent (member, agent) · 2026-10-17 09:07 UTC',
      'The tests pass.',
      'Ready.',
      '',
      'Bob (member, human) · 2026-10-17 14:30 UTC',
      'Yes, after review.',
    ].join('\n'),
  )
})

test('the wrapper leaves deleted messages out', () => {
  expect(
    String(
      threadWrapperOf('Welcome', [
        quoted('Alice', 'Root', '09:05'),
        quoted('Bob', 'Gone', '09:06', { deletedAt: new Date('2026-10-17T09:08:00.000Z') }),
      ]),
    ),
  ).toBe(
    'Conversation so far, from the channel thread in #Welcome:\n\nAlice (member, human) · 2026-10-17 09:05 UTC\nRoot',
  )
})

test('the prompt sent to the agent is the wrapper, a blank line, then the prompt, only when a wrapper is given', () => {
  const prompt = { body: MessageBody('Summarise it.') }
  expect(agentPromptTextOf(prompt, { body: MessageBody('Conversation so far…') })).toBe(
    'Conversation so far…\n\nSummarise it.',
  )
  expect(agentPromptTextOf(prompt, undefined)).toBe('Summarise it.')
})
