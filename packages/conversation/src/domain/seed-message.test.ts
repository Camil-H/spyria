import { expect, test } from 'bun:test'
import { MessageBody } from './message-body.ts'
import {
  agentPromptTextOf,
  channelThreadHeaderOf,
  type QuotedMessage,
  runtimeChatHeaderOf,
  seedMessageBodyOf,
} from './seed-message.ts'

const quoted = (
  authorName: string,
  body: string,
  time: string,
  fields: Partial<QuotedMessage> = {},
): QuotedMessage => ({
  authorName,
  kind: 'member',
  body: MessageBody(body),
  attachments: [],
  createdAt: new Date(`2026-10-17T${time}:00.000Z`),
  status: 'live',
  ...fields,
})

test('the seed message quotes each message with its author, kind and UTC time, a blank line between', () => {
  expect(
    String(
      seedMessageBodyOf(channelThreadHeaderOf('Welcome'), [
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

test('the seed message leaves deleted messages out', () => {
  expect(
    String(
      seedMessageBodyOf(channelThreadHeaderOf('Welcome'), [
        quoted('Alice', 'Root', '09:05'),
        quoted('Bob', 'Gone', '09:06', { status: 'deleted' }),
      ]),
    ),
  ).toBe(
    'Conversation so far, from the channel thread in #Welcome:\n\nAlice (member, human) · 2026-10-17 09:05 UTC\nRoot',
  )
})

test('the prompt sent to the agent is the seed message, a blank line, then the prompt, only when a seed message is given', () => {
  const prompt = { body: MessageBody('Summarise it.'), attachments: [] }
  expect(agentPromptTextOf(prompt, { body: MessageBody('Conversation so far…') })).toBe(
    'Conversation so far…\n\nSummarise it.',
  )
  expect(agentPromptTextOf(prompt, undefined)).toBe('Summarise it.')
})

test('a forked runtime chat quotes its member and agent messages under the runtime chat header, without deleted messages', () => {
  expect(
    String(
      seedMessageBodyOf(runtimeChatHeaderOf('Invoice bug'), [
        quoted('Alice', 'Find the bug.', '09:05'),
        quoted('Agent', 'Found it.', '09:07', { kind: 'agent' }),
        quoted('Alice', 'Gone', '09:09', { status: 'deleted' }),
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

test('attachments are named to the agent, which cannot read them, also on a prompt without text', () => {
  const photo = { id: 'a1', name: 'photo.png', mediaType: 'image/png', size: 150 * 1024 }
  expect(agentPromptTextOf({ body: MessageBody('What is this?'), attachments: [photo] }, undefined)).toBe(
    'What is this?\n\nAttached, not readable by you: photo.png (image/png, 150 KB)',
  )
  expect(agentPromptTextOf({ body: MessageBody('', { allowsBlank: true }), attachments: [photo] }, undefined)).toBe(
    'Attached, not readable by you: photo.png (image/png, 150 KB)',
  )
  expect(
    String(
      seedMessageBodyOf(channelThreadHeaderOf('Welcome'), [quoted('Alice', 'Look', '09:05', { attachments: [photo] })]),
    ),
  ).toContain('Alice (member, human) · 2026-10-17 09:05 UTC\nLook\n\nAttached, not readable by you: photo.png')
})
