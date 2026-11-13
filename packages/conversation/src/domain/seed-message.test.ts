import { expect, test } from 'bun:test'
import { messageId } from '@spyria/kernel'
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

test('the attachments of a prompt are given to the agent by the paths they were saved at, also without text, and one not saved is named as not readable', () => {
  const photo = { id: 'a1', name: 'photo.png', mediaType: 'image/png', size: 150 * 1024 }
  const report = { id: 'a2', name: 'report.pdf', mediaType: 'application/pdf', size: 2048 }
  const song = { id: 'a3', name: 'song.mp3', mediaType: 'audio/mpeg', size: 3 * 1024 * 1024 }
  const savedPaths = new Map([
    ['a1', '/workspace/attachments/a1/photo.png'],
    ['a2', '/workspace/attachments/a2/report.pdf'],
  ])
  expect(
    agentPromptTextOf(
      { body: MessageBody('What is this?'), attachments: [photo, report, song] },
      undefined,
      undefined,
      savedPaths,
    ),
  ).toBe(
    [
      'What is this?',
      'Attached files, saved in your workspace: /workspace/attachments/a1/photo.png (image/png, 150 KB), /workspace/attachments/a2/report.pdf (application/pdf, 2 KB)',
      'Attached, not readable by you: song.mp3 (audio/mpeg, 3.0 MB)',
    ].join('\n\n'),
  )
  expect(
    agentPromptTextOf(
      { body: MessageBody('', { allowsBlank: true }), attachments: [report] },
      undefined,
      undefined,
      savedPaths,
    ),
  ).toBe('Attached files, saved in your workspace: /workspace/attachments/a2/report.pdf (application/pdf, 2 KB)')
})

test('attachments of earlier messages are named to the agent as not readable, images included', () => {
  const photo = { id: 'a1', name: 'photo.png', mediaType: 'image/png', size: 150 * 1024 }
  expect(
    String(
      seedMessageBodyOf(channelThreadHeaderOf('Welcome'), [quoted('Alice', 'Look', '09:05', { attachments: [photo] })]),
    ),
  ).toContain('Alice (member, human) · 2026-10-17 09:05 UTC\nLook\n\nAttached, not readable by you: photo.png')
})

test('a prompt that replies to a message quotes it to the agent with its author and time, after the seed message, unless it was deleted', () => {
  const prompt = { body: MessageBody('Why?'), attachments: [] }
  const answer = quoted('Agent', 'The tax is applied twice.\nSee invoice.ts.', '09:07', { kind: 'agent' })
  expect(agentPromptTextOf(prompt, { body: MessageBody('Conversation so far…') }, answer)).toBe(
    [
      'Conversation so far…',
      '',
      'In reply to Agent (agent) · 2026-10-17 09:07 UTC:',
      '> The tax is applied twice.',
      '> See invoice.ts.',
      '',
      'Why?',
    ].join('\n'),
  )
  expect(agentPromptTextOf(prompt, undefined, { ...answer, status: 'deleted' })).toBe('Why?')
})

test('a prompt of the quality gates is quoted as theirs, an automatic prompt, not as a member’s', () => {
  const loopPrompt = quoted('Quality gates', 'Lint failed.', '09:05', {
    step: { type: 'dev_loop_prompt', loopId: messageId('message-loop'), phase: 'command' },
  })
  expect(agentPromptTextOf({ body: MessageBody('Why?'), attachments: [] }, undefined, loopPrompt)).toBe(
    'In reply to Quality gates (automatic prompt) · 2026-10-17 09:05 UTC:\n> Lint failed.\n\nWhy?',
  )
})
