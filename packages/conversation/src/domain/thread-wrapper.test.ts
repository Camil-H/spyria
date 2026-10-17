import { expect, test } from 'bun:test'
import { MessageBody } from './message-body.ts'
import {
  agentPromptTextOf,
  channelThreadHeaderOf,
  type QuotedMessage,
  runtimeChatHeaderOf,
  threadWrapperOf,
} from './thread-wrapper.ts'

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
      threadWrapperOf(channelThreadHeaderOf('Welcome'), [
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
      'Agent (agent) · 2026-10-17 09:07 UTC',
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
      threadWrapperOf(channelThreadHeaderOf('Welcome'), [
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

test('a forked runtime chat quotes its member and agent messages under the runtime chat header, without deleted messages', () => {
  expect(
    String(
      threadWrapperOf(runtimeChatHeaderOf('Invoice bug'), [
        quoted('Alice', 'Find the bug.', '09:05'),
        quoted('Agent', 'Found it.', '09:07', { kind: 'agent' }),
        quoted('Alice', 'Gone', '09:09', { deletedAt: new Date('2026-10-17T09:10:00.000Z') }),
        quoted('Alice', 'Fix it.', '09:11'),
      ]),
    ),
  ).toBe(
    [
      'Conversation so far, from the runtime chat Invoice bug:',
      '',
      'Alice (member, human) · 2026-10-17 09:05 UTC',
      'Find the bug.',
      '',
      'Agent (agent) · 2026-10-17 09:07 UTC',
      'Found it.',
      '',
      'Alice (member, human) · 2026-10-17 09:11 UTC',
      'Fix it.',
    ].join('\n'),
  )
})
