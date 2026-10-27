import { expect, test } from 'bun:test'
import { acme, alice, bob, createMockSnapshot, lee, type Snapshot } from '@spyria/db'
import { chatId, messageId, runtimeHostId, runtimeId } from '@spyria/kernel'
import { stillRunningOf } from '../domain/delegation.ts'
import type { RunsOn } from '../domain/session-routing.ts'
import { durationLabelOf, getConversation } from './get-conversation.ts'

const research = chatId('chat-research')
const prompt = messageId('message-prompt')

const snapshotWith = ({ turn, waiting }: { turn: boolean; waiting: boolean }): Snapshot => {
  const snapshot = createMockSnapshot()
  return {
    ...snapshot,
    chats: snapshot.chats.map((chat) =>
      chat.id === research ? { ...chat, agentTurnMessageId: turn ? prompt : null } : chat,
    ),
    messages: [
      ...snapshot.messages,
      {
        id: prompt,
        workspaceId: acme,
        chatId: research,
        seq: 1,
        kind: 'member',
        authorId: alice,
        body: 'Find the latest pricing',
        attachments: [],
        detail: null,
        step: null,
        replyToId: null,
        threadRootId: null,
        createdAt: '2026-10-01T09:00:00.000Z',
        editedAt: null,
        deletedAt: null,
        needsReply: waiting,
      },
    ],
  }
}
const activityOf = (state: { turn: boolean; waiting: boolean }) => {
  const conversation = getConversation(acme, research, alice)(snapshotWith(state))
  return { isAgentWorking: conversation?.isAgentWorking, hasActiveTurn: conversation?.hasActiveTurn }
}

test('the agent works while the chat has an active turn or a prompt waiting for its turn; Stop needs the turn', () => {
  expect(activityOf({ turn: false, waiting: false })).toEqual({ isAgentWorking: false, hasActiveTurn: false })
  expect(activityOf({ turn: true, waiting: false })).toEqual({ isAgentWorking: true, hasActiveTurn: true })
  expect(activityOf({ turn: false, waiting: true })).toEqual({ isAgentWorking: true, hasActiveTurn: false })
  expect(activityOf({ turn: true, waiting: true })).toEqual({ isAgentWorking: true, hasActiveTurn: true })
})

test('the read marker is behind until it reaches the newest message of the chat flow', () => {
  const snapshot = snapshotWith({ turn: false, waiting: false })
  const isBehindAt = (lastReadSeq: number | null) =>
    getConversation(
      acme,
      research,
      alice,
    )({
      ...snapshot,
      readMarkers: lastReadSeq === null ? [] : [{ workspaceId: acme, memberId: alice, chatId: research, lastReadSeq }],
    })?.isReadMarkerBehind
  expect(isBehindAt(null)).toBe(true)
  expect(isBehindAt(0)).toBe(true)
  expect(isBehindAt(1)).toBe(false)
})

const turnStart = Date.UTC(2026, 9, 1, 9, 0)
type StepRow = Snapshot['messages'][number]['step']
const replyRow = (
  seq: number,
  kind: 'agent' | 'step' | 'notice',
  fields: { body?: string; step?: StepRow; at?: number; replyToId?: string | null } = {},
) => ({
  id: messageId(`message-${seq}`),
  workspaceId: acme,
  chatId: research,
  seq,
  kind,
  authorId: null,
  body: fields.body ?? kind,
  attachments: [],
  detail: null,
  step: fields.step ?? null,
  replyToId: fields.replyToId === undefined ? prompt : fields.replyToId === null ? null : messageId(fields.replyToId),
  threadRootId: null,
  createdAt: new Date(turnStart + (fields.at ?? seq) * 1000).toISOString(),
  editedAt: null,
  deletedAt: null,
  needsReply: false,
})
const thought = { type: 'thought', text: 'Check the toolchain.', durationMilliseconds: 4000 } as const
const command = (exitCode: number | null) => ({
  type: 'command' as const,
  command: 'python3 --version',
  exitCode,
  durationMilliseconds: exitCode === null ? null : 1200,
  output: 'Python 3.12.3',
  truncatedLines: 0,
  thought,
})
const edit = { type: 'file', operation: 'edit', path: 'totals.ts', added: 2, removed: 1, diff: [] } as const
const conversationWith = (rows: ReturnType<typeof replyRow>[], isTurnActive = false) => {
  const snapshot = snapshotWith({ turn: isTurnActive, waiting: false })
  return getConversation(acme, research, alice)({ ...snapshot, messages: [...snapshot.messages, ...rows] })
}
const itemSummaryOf = (conversation: ReturnType<typeof conversationWith>) =>
  conversation?.items.map((item) =>
    item.type === 'fold'
      ? `fold ${item.label}: ${item.steps.map((step) => step.step?.type).join(', ')}`
      : `${item.message.kind}${item.message.step ? ` ${item.message.step.type}` : ''}`,
  )

test('an ended turn folds its steps into one line above the answer, with the thought before its command', () => {
  const conversation = conversationWith([
    replyRow(2, 'step', { step: command(0), at: 5 }),
    replyRow(3, 'step', { step: edit, at: 20 }),
    replyRow(4, 'agent', { body: 'Fixed.', at: 77 }),
  ])
  expect(itemSummaryOf(conversation)).toEqual([
    'member',
    'fold Worked for 1m 12s · 3 steps: thought, command, file',
    'agent',
  ])
  const fold = conversation?.items[1]
  expect(fold?.type === 'fold' && fold.steps[0]?.step).toEqual(thought)
  expect(fold?.type === 'fold' && fold.steps[1]?.step).not.toHaveProperty('thought')
})

test('text the agent wrote between steps folds with them in order, and text before the first step stays above the fold', () => {
  const conversation = conversationWith([
    replyRow(2, 'agent', { body: 'Looking.' }),
    replyRow(3, 'step', { step: { ...command(0), thought: undefined } }),
    replyRow(4, 'agent', { body: 'Now the edit.' }),
    replyRow(5, 'step', { step: edit }),
    replyRow(6, 'agent', { body: 'Fixed.' }),
  ])
  expect(itemSummaryOf(conversation)).toEqual([
    'member',
    'agent',
    'fold Worked for 3s · 2 steps: command, , file',
    'agent',
  ])
  const fold = conversation?.items[2]
  expect(fold?.type === 'fold' && fold.steps.map((step) => step.body)).toEqual(['step', 'Now the edit.', 'step'])
  const endedOnStep = conversationWith([
    replyRow(2, 'agent', { body: 'Looking.' }),
    replyRow(3, 'step', { step: { ...command(0), thought: undefined } }),
    replyRow(4, 'step', { step: edit }),
  ])
  expect(itemSummaryOf(endedOnStep)).toEqual(['member', 'agent', 'step command', 'step file'])
})

test('an active turn shows its steps live and unfolded, its pending command running', () => {
  const conversation = conversationWith([replyRow(2, 'step', { step: command(null) })], true)
  expect(itemSummaryOf(conversation)).toEqual(['member', 'step thought', 'step command'])
  const running = conversation?.items[2]
  expect(running?.type === 'message' && running.message.isRunning).toBe(true)
  const narrating = conversationWith(
    [replyRow(2, 'step', { step: command(0) }), replyRow(3, 'step', { step: edit }), replyRow(4, 'agent')],
    true,
  )
  expect(itemSummaryOf(narrating)).toEqual(['member', 'step thought', 'step command', 'step file', 'agent'])
})

test('a turn with a single step, without an answer, stopped or failed stays unfolded', () => {
  const single = conversationWith([
    replyRow(2, 'step', { step: { ...command(0), thought: undefined } }),
    replyRow(3, 'agent', { body: 'Done.' }),
  ])
  expect(itemSummaryOf(single)).toEqual(['member', 'step command', 'agent'])
  const failed = conversationWith([
    replyRow(2, 'step', { step: command(0) }),
    replyRow(3, 'step', { step: { type: 'error', message: 'boom' } }),
    replyRow(4, 'notice', { body: 'The agent stopped with an error' }),
  ])
  expect(itemSummaryOf(failed)).toEqual(['member', 'step thought', 'step command', 'step error', 'notice'])
  const finishedRunning = failed?.items[2]
  expect(finishedRunning?.type === 'message' && finishedRunning.message.isRunning).toBe(false)
  const stopped = conversationWith([
    replyRow(2, 'step', { step: command(0) }),
    replyRow(3, 'step', { step: edit }),
    replyRow(4, 'agent', { body: 'Partly done.' }),
    replyRow(5, 'notice', { body: 'Stopped by Alice' }),
  ])
  expect(itemSummaryOf(stopped)).toEqual(['member', 'step thought', 'step command', 'step file', 'agent', 'notice'])
})

test('the error the interrupt causes is hidden in a stopped turn', () => {
  const stopped = conversationWith([
    replyRow(2, 'step', { step: edit }),
    replyRow(3, 'notice', { body: 'Stopped by Alice' }),
    replyRow(4, 'step', { step: { type: 'error', message: 'Tool call interrupted before completion.' } }),
  ])
  expect(itemSummaryOf(stopped)).toEqual(['member', 'step file', 'notice'])
})

test('a question stays out of the fold where it was asked and its answerer is named', () => {
  const question = { type: 'question', questionId: 'q1', kind: 'question', answers: {}, answeredBy: alice } as const
  const conversation = conversationWith([
    replyRow(2, 'step', { step: command(0) }),
    replyRow(3, 'step', { step: question }),
    replyRow(4, 'step', { step: edit }),
    replyRow(6, 'step', { step: { ...question, questionId: 'q2' } }),
    replyRow(7, 'agent', { body: 'Done.' }),
  ])
  expect(itemSummaryOf(conversation)).toEqual([
    'member',
    'fold Worked for 5s · 3 steps: thought, command, file',
    'step question',
    'step question',
    'agent',
  ])
  const answered = conversation?.items[2]
  expect(answered?.type === 'message' && answered.message.answeredByName).toBe('Alice')
})

test('steps outside any turn, like migrated tool calls, are shown as they are', () => {
  const conversation = conversationWith([
    replyRow(2, 'step', { step: { ...command(null), thought: undefined }, replyToId: null }),
    replyRow(3, 'agent', { body: 'Done.', replyToId: null }),
  ])
  expect(itemSummaryOf(conversation)).toEqual(['member', 'step command', 'agent'])
  const legacy = conversation?.items[1]
  expect(legacy?.type === 'message' && legacy.message.isRunning).toBe(false)
})

const delegateAction = (task: string, result: string | null) => ({
  type: 'tool' as const,
  name: 'delegate',
  arguments: JSON.stringify({ task, effort: 'small' }),
  result,
})
const delegatedEdit = (id: string, task = 'List the files') => ({
  ...edit,
  delegation: { id, model: 'mistral/mistral-small-latest', modelName: 'Mistral Small', task },
})
const delegationGroupsOf = (conversation: ReturnType<typeof conversationWith>) =>
  conversation?.items
    .flatMap((item) => (item.type === 'fold' ? item.steps : [item.message]))
    .flatMap(({ id, step, delegation }) =>
      delegation
        ? [
            {
              id: String(id),
              result: step?.type === 'tool' ? step.result : undefined,
              steps: delegation.steps.map((delegated) => String(delegated.id)),
              durationMilliseconds: delegation.durationMilliseconds,
            },
          ]
        : [],
    )

test('the steps of a delegation are grouped into the delegate action whose task they carry', () => {
  const conversation = conversationWith([
    replyRow(2, 'step', { step: delegateAction('List the files', 'Two files.'), at: 2 }),
    replyRow(3, 'step', { step: delegatedEdit('delegation-1'), at: 5 }),
    replyRow(4, 'step', { step: delegatedEdit('delegation-1'), at: 9 }),
    replyRow(5, 'agent', { body: 'Listed.', at: 12 }),
  ])
  expect(itemSummaryOf(conversation)).toEqual(['member', 'step tool', 'agent'])
  expect(delegationGroupsOf(conversation)).toEqual([
    { id: 'message-2', result: 'Two files.', steps: ['message-3', 'message-4'], durationMilliseconds: 7000 },
  ])
})

test('a delegate action stored after its delegation steps still gathers them, where the action sits', () => {
  const conversation = conversationWith([
    replyRow(2, 'step', { step: delegatedEdit('delegation-1'), at: 5 }),
    replyRow(3, 'step', { step: delegatedEdit('delegation-1'), at: 9 }),
    replyRow(4, 'step', { step: delegateAction('List the files', 'Two files.'), at: 10 }),
    replyRow(5, 'agent', { body: 'Listed.', at: 12 }),
  ])
  expect(itemSummaryOf(conversation)).toEqual(['member', 'step tool', 'agent'])
  expect(delegationGroupsOf(conversation)).toEqual([
    { id: 'message-4', result: 'Two files.', steps: ['message-2', 'message-3'], durationMilliseconds: 5000 },
  ])
})

test('a delegation without a matching delegate action is still one group, at its first step', () => {
  const rows = [
    replyRow(2, 'step', { step: delegateAction('Another task', null), at: 2 }),
    replyRow(3, 'step', { step: delegatedEdit('delegation-1'), at: 5 }),
    replyRow(4, 'step', { step: delegatedEdit('delegation-1'), at: 9 }),
  ]
  const running = conversationWith(rows, true)
  expect(itemSummaryOf(running)).toEqual(['member', 'step tool', 'step tool'])
  expect(delegationGroupsOf(running)).toEqual([
    { id: 'message-3', result: null, steps: ['message-3', 'message-4'], durationMilliseconds: null },
  ])
  expect(delegationGroupsOf(conversationWith(rows))).toEqual([
    { id: 'message-3', result: '', steps: ['message-3', 'message-4'], durationMilliseconds: 4000 },
  ])
})

test('two delegations of the same task in one turn match the delegate actions in order', () => {
  const conversation = conversationWith([
    replyRow(2, 'step', { step: delegateAction('List the files', 'First.'), at: 2 }),
    replyRow(3, 'step', { step: delegatedEdit('delegation-1'), at: 3 }),
    replyRow(4, 'step', { step: delegatedEdit('delegation-1'), at: 4 }),
    replyRow(5, 'step', { step: delegateAction('List the files', 'Second.'), at: 5 }),
    replyRow(6, 'step', { step: delegatedEdit('delegation-2'), at: 6 }),
    replyRow(7, 'agent', { body: 'Listed twice.', at: 8 }),
  ])
  expect(itemSummaryOf(conversation)).toEqual(['member', 'fold Worked for 6s · 2 steps: tool, tool', 'agent'])
  expect(delegationGroupsOf(conversation)).toEqual([
    { id: 'message-2', result: 'First.', steps: ['message-3', 'message-4'], durationMilliseconds: 2000 },
    { id: 'message-5', result: 'Second.', steps: ['message-6'], durationMilliseconds: 1000 },
  ])
})

test('durations read in seconds, tenths under ten seconds, and minutes', () => {
  expect(durationLabelOf(400)).toBe('0.4s')
  expect(durationLabelOf(4000)).toBe('4s')
  expect(durationLabelOf(12_400)).toBe('12s')
  expect(durationLabelOf(72_000)).toBe('1m 12s')
})

test('a Claude Code subagent gathers the steps that carry its tool call id into its Task step', () => {
  const subagentEdit = { ...edit, delegation: { id: 'message-2', model: '', modelName: '', task: '' } }
  const conversation = conversationWith([
    replyRow(2, 'step', { step: { type: 'tool', name: 'Task', arguments: '{}', result: 'Listed.' }, at: 2 }),
    replyRow(3, 'step', { step: subagentEdit, at: 5 }),
    replyRow(4, 'step', { step: subagentEdit, at: 6 }),
    replyRow(5, 'agent', { body: 'Done.', at: 8 }),
  ])
  expect(itemSummaryOf(conversation)).toEqual(['member', 'step tool', 'agent'])
  expect(delegationGroupsOf(conversation)).toEqual([
    { id: 'message-2', result: 'Listed.', steps: ['message-3', 'message-4'], durationMilliseconds: 4000 },
  ])
})

const delegationStatesOf = (conversation: ReturnType<typeof conversationWith>) =>
  conversation?.items.flatMap((item) =>
    item.type === 'message' && item.message.delegation
      ? [
          {
            id: String(item.message.id),
            status: item.message.delegation.status,
            result: item.message.delegation.result,
            steps: item.message.delegation.steps.length,
          },
        ]
      : [],
  )
const awaitAction = (id: string, result: string | null) => ({
  type: 'tool' as const,
  name: 'await_task',
  arguments: JSON.stringify({ taskId: id }),
  result,
})

test('an awaited delegation stays one group with await_task’s answer, and the next delegation of that task gets its own', () => {
  const conversation = conversationWith([
    replyRow(2, 'step', { step: delegateAction('List the files', stillRunningOf('delegation-1')) }),
    replyRow(3, 'step', { step: delegatedEdit('delegation-1') }),
    replyRow(4, 'step', { step: awaitAction('delegation-1', 'First.') }),
    replyRow(5, 'step', { step: delegateAction('List the files', 'Second.') }),
    replyRow(6, 'step', { step: delegatedEdit('delegation-2') }),
  ])
  expect(delegationStatesOf(conversation)).toEqual([
    { id: 'message-2', status: 'finished', result: 'First.', steps: 1 },
    { id: 'message-5', status: 'finished', result: 'Second.', steps: 1 },
  ])
})

test('a delegation still running reads running, without its still-running answer as a result; an error reads failed, stopped once the turn is', () => {
  const stillRunning = conversationWith(
    [
      replyRow(2, 'step', { step: delegateAction('List the files', stillRunningOf('delegation-1')) }),
      replyRow(3, 'step', { step: delegatedEdit('delegation-1') }),
    ],
    true,
  )
  expect(delegationStatesOf(stillRunning)).toEqual([{ id: 'message-2', status: 'running', result: null, steps: 1 }])
  const interrupted = (isStopped: boolean) =>
    delegationStatesOf(
      conversationWith([
        replyRow(2, 'step', { step: { ...delegateAction('List the files', 'Interrupted.'), isError: true } }),
        replyRow(3, 'step', { step: delegatedEdit('delegation-1') }),
        ...(isStopped ? [replyRow(4, 'notice', { body: 'Stopped by Alice' })] : []),
      ]),
    )?.map(({ status }) => status)
  expect(interrupted(true)).toEqual(['stopped'])
  expect(interrupted(false)).toEqual(['failed'])
})

test.each([
  ['the owner', alice, { canPost: true, canConfigure: true }, true],
  ['a prompter', bob, { canPost: true, canConfigure: false }, true],
  ['a reader', lee, { canPost: false, canConfigure: false }, false],
])(
  '%s of Invoice bug posts and configures by their role, and edits only their own messages when they post',
  (_, viewer, access, canEditOwn) => {
    const invoiceBug = chatId('chat-invoice-bug')
    const snapshot = createMockSnapshot()
    const othersMessage = { ...replyRow(2, 'agent'), chatId: invoiceBug, id: messageId('others'), authorId: null }
    const ownMessage = { ...othersMessage, kind: 'member' as const, id: messageId('own'), authorId: viewer }
    const conversation = getConversation(
      acme,
      invoiceBug,
      viewer,
    )({ ...snapshot, messages: [...snapshot.messages, othersMessage, ownMessage] })
    const canEditOf = (id: string) => conversation?.messages.find((message) => message.id === id)?.canEdit
    expect(conversation).toMatchObject(access)
    expect(canEditOf('own')).toBe(canEditOwn)
    expect(canEditOf('others')).toBe(false)
  },
)

test('messages carry their edited flag and the agent as their author', () => {
  const edited = { ...replyRow(2, 'agent'), editedAt: '2026-10-01T09:01:00.000Z' }
  const snapshot = snapshotWith({ turn: false, waiting: false })
  const message = getConversation(
    acme,
    research,
    alice,
  )({ ...snapshot, messages: [...snapshot.messages, edited] })?.messages.find(({ id }) => id === edited.id)
  expect(message).toMatchObject({ isEdited: true, authorName: 'Agent' })
  expect(conversationWith([replyRow(2, 'agent')])?.messages.at(-1)?.isEdited).toBe(false)
})

test('a message carries the picture of its member author, an agent message none', () => {
  const picture = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
  const snapshot = snapshotWith({ turn: false, waiting: false })
  const conversation = getConversation(
    acme,
    research,
    alice,
  )({
    ...snapshot,
    memberships: snapshot.memberships.map((membership) =>
      membership.memberId === alice ? { ...membership, avatar: picture } : membership,
    ),
    messages: [...snapshot.messages, replyRow(2, 'agent')],
  })
  const messageWith = (id: string) => conversation?.messages.find((message) => message.id === id)
  expect(messageWith(prompt)).toMatchObject({ authorName: 'Alice', authorAvatar: picture })
  expect(messageWith(replyRow(2, 'agent').id)).toMatchObject({ authorName: 'Agent', authorAvatar: null })
})

type RunsOnSetup = {
  viewer?: typeof alice
  isOwner?: boolean
  spyriaRuntimeAvailable?: boolean
  isTurnActive?: boolean
  machineSession?: 'online' | 'offline'
  workspaceHost?: 'online' | 'offline'
  machine?: 'online' | 'offline'
  signedIn?: string[]
  isSwitchOff?: boolean
  reply?: 'agent' | 'step'
}
const runsOnChoicesOf = ({
  viewer = alice,
  isOwner = true,
  spyriaRuntimeAvailable,
  isTurnActive = false,
  machineSession,
  workspaceHost,
  machine,
  signedIn = [],
  isSwitchOff = false,
  reply,
}: RunsOnSetup) => {
  const snapshot = snapshotWith({ turn: isTurnActive, waiting: false })
  const hostRow = (id: string, status: 'online' | 'offline', ownerId: typeof alice | null) => ({
    workspaceId: acme,
    id: runtimeHostId(id),
    name: id,
    status,
    claimExpiresAt: null,
    capacity: {
      cpus: 4,
      memoryBytes: 8,
      dockerVersion: '29',
      rootless: true,
      cgroupDriver: 'systemd',
      limitsEnforced: true,
      cap: 2,
      signedIn,
    },
    runningRuntimes: 0,
    ownerId,
  })
  return getConversation(
    acme,
    research,
    viewer,
    spyriaRuntimeAvailable,
  )({
    ...snapshot,
    workspaces: snapshot.workspaces.map((workspace) => ({
      ...workspace,
      localSessions: workspace.id !== acme || !isSwitchOff,
    })),
    chats: snapshot.chats.map((chat) => (chat.id === research ? { ...chat, ownerId: isOwner ? viewer : bob } : chat)),
    messages: [...snapshot.messages, ...(reply ? [replyRow(2, reply)] : [])],
    runtimeHosts: [
      ...(workspaceHost ? [hostRow('host-workspace', workspaceHost, null)] : []),
      ...(machine ? [hostRow('host-machine', machine, viewer)] : []),
    ],
    runtimes: machineSession
      ? [
          {
            workspaceId: acme,
            id: runtimeId('runtime-machine'),
            chatId: research,
            hostId: runtimeHostId('host-machine'),
            state: 'running',
            failure: null,
            hostOnline: machineSession === 'online',
          },
        ]
      : [],
  })?.runsOnChoices
}

test.each<[string, RunsOnSetup, readonly RunsOn[] | null]>([
  ['admin owner, nothing connected', {}, ['runtime']],
  [
    'admin owner, workspace host and both tools',
    { workspaceHost: 'online', machine: 'online', signedIn: ['claude-code', 'codex'] },
    ['runtime', 'claude-code', 'codex'],
  ],
  [
    'admin owner, offline workspace host, Claude signed in',
    { workspaceHost: 'offline', machine: 'online', signedIn: ['claude-code'] },
    ['claude-code'],
  ],
  [
    'admin owner, workspace host, Codex signed in',
    { workspaceHost: 'online', machine: 'online', signedIn: ['codex'] },
    ['runtime', 'codex'],
  ],
  ['admin owner, machine online with no tool signed in', { machine: 'online' }, ['runtime']],
  [
    'admin owner, machine offline with both tools',
    { machine: 'offline', signedIn: ['claude-code', 'codex'] },
    ['runtime'],
  ],
  ['not the owner', { isOwner: false }, null],
  [
    'member owner, availability unknown, Claude signed in',
    { viewer: bob, machine: 'online', signedIn: ['claude-code'] },
    null,
  ],
  ['member owner, availability unknown, nothing connected', { viewer: bob }, ['runtime']],
  [
    'member owner, Spyria runtime available, Claude signed in',
    { viewer: bob, spyriaRuntimeAvailable: true, machine: 'online', signedIn: ['claude-code'] },
    ['runtime', 'claude-code'],
  ],
  [
    'member owner, Spyria runtime unavailable, Claude signed in',
    { viewer: bob, spyriaRuntimeAvailable: false, machine: 'online', signedIn: ['claude-code'] },
    ['claude-code'],
  ],
  [
    'member owner ignores an online workspace host',
    { viewer: bob, spyriaRuntimeAvailable: false, workspaceHost: 'online', machine: 'online', signedIn: ['codex'] },
    ['codex'],
  ],
  ['an active turn', { isTurnActive: true, workspaceHost: 'online' }, null],
  [
    'a machine session on an online host',
    { machineSession: 'online', machine: 'online', signedIn: ['claude-code'] },
    null,
  ],
  [
    'a machine session whose host is offline',
    { machineSession: 'offline', machine: 'online', signedIn: ['claude-code'] },
    ['claude-code'],
  ],
  [
    'the workspace switch off',
    { isSwitchOff: true, workspaceHost: 'online', machine: 'online', signedIn: ['claude-code', 'codex'] },
    ['runtime'],
  ],
  ['an agent message', { reply: 'agent' }, null],
  ['a step message', { reply: 'step' }, null],
])('Runs on choices: %s', (_, setup, expected) => {
  expect(runsOnChoicesOf(setup)).toEqual(expected)
})

test('a chat started from a chat the viewer cannot read shows no origin link', () => {
  const snapshot = createMockSnapshot()
  const startedFrom = (sourceId: string) =>
    getConversation(
      acme,
      research,
      alice,
    )({
      ...snapshot,
      chats: snapshot.chats.map((chat) => (chat.id === research ? { ...chat, originChatId: chatId(sourceId) } : chat)),
    })?.origin
  expect(startedFrom('chat-welcome')).toEqual({ chatId: chatId('chat-welcome'), name: 'Welcome', type: 'channel' })
  expect(startedFrom('chat-not-synced')).toBeNull()
})

const welcome = chatId('chat-welcome')
const welcomeRoot = messageId('message-welcome-2')
const threadReply = (seq: number, authorId: typeof alice, fields: Partial<Snapshot['messages'][number]> = {}) => ({
  ...replyRow(seq, 'agent'),
  chatId: welcome,
  id: messageId(`reply-${seq}`),
  kind: 'member' as const,
  authorId,
  replyToId: null,
  threadRootId: welcomeRoot,
  ...fields,
})
const welcomeFor = (
  viewer: typeof alice,
  rows: readonly Snapshot['messages'][number][],
  fields: Partial<Snapshot> = {},
) => {
  const snapshot = createMockSnapshot()
  return getConversation(acme, welcome, viewer)({ ...snapshot, messages: [...snapshot.messages, ...rows], ...fields })
}

test('thread replies stay out of the channel flow and gather in order under their root, with the viewer’s new ones counted', () => {
  const conversation = welcomeFor(
    alice,
    [
      threadReply(3, bob),
      threadReply(4, alice),
      threadReply(5, bob),
      threadReply(6, bob, { deletedAt: '2026-10-01T09:10:00.000Z' }),
    ],
    {
      threadReadMarkers: [
        { workspaceId: acme, memberId: alice, chatId: welcome, threadRootId: welcomeRoot, lastReadSeq: 3 },
      ],
    },
  )
  expect(conversation?.messages.map((message) => String(message.id))).toEqual([
    'message-welcome-1',
    'message-welcome-2',
  ])
  expect(conversation?.items.map((item) => item.type === 'message' && String(item.message.id))).toEqual([
    'message-welcome-1',
    'message-welcome-2',
  ])
  expect(conversation?.messages[0]?.thread).toEqual({ replies: [], newCount: 0 })
  const thread = conversation?.messages[1]?.thread
  expect(thread?.replies.map((reply) => String(reply.id))).toEqual(['reply-3', 'reply-4', 'reply-5', 'reply-6'])
  expect(thread?.newCount).toBe(1)
  expect(thread?.replies[0]).toMatchObject({ authorName: 'Bob', canReply: false, thread: null })
  expect(welcomeFor(alice, [threadReply(3, bob), threadReply(4, bob)])?.messages[1]?.thread?.newCount).toBe(2)
})

test.each([
  ['a top-level channel message for a poster', alice, [], 'message-welcome-2', { canReply: true, hasThread: true }],
  [
    'a deleted root, which keeps its thread',
    alice,
    [{ deletedAt: '2026-10-01T09:10:00.000Z' }],
    'message-welcome-2',
    { canReply: false, hasThread: true },
  ],
  ['a top-level channel message for a reader', lee, [], 'message-welcome-2', { canReply: false, hasThread: true }],
] as const)('reply in thread on %s', (_, viewer, [rootFields], id, { canReply, hasThread }) => {
  const snapshot = createMockSnapshot()
  const conversation = getConversation(
    acme,
    welcome,
    viewer,
  )({
    ...snapshot,
    messages: snapshot.messages.map((message) =>
      message.id === welcomeRoot ? { ...message, ...rootFields } : message,
    ),
    chatMembers: [...snapshot.chatMembers, { workspaceId: acme, chatId: welcome, memberId: lee, roleId: 'reader' }],
  })
  const message = conversation?.messages.find((candidate) => candidate.id === id)
  expect({ canReply: message?.canReply, hasThread: message?.thread !== null }).toEqual({ canReply, hasThread })
})

test('a runtime chat has no threads', () => {
  expect(
    conversationWith([replyRow(2, 'agent')])?.messages.map(({ canReply, thread }) => ({ canReply, thread })),
  ).toEqual([
    { canReply: false, thread: null },
    { canReply: false, thread: null },
  ])
})

test('a message started into runtimes links each one the viewer can read and names the starter of the others', () => {
  const runtimeOrigins = [
    { workspaceId: acme, chatId: welcome, runtimeChatId: research, messageId: welcomeRoot, startedBy: alice },
    {
      workspaceId: acme,
      chatId: welcome,
      runtimeChatId: chatId('chat-invoice-bug'),
      messageId: welcomeRoot,
      startedBy: bob,
    },
  ]
  const runtimesSeenBy = (viewer: typeof alice) =>
    welcomeFor(viewer, [], { runtimeOrigins })?.messages.find((message) => message.id === welcomeRoot)?.runtimes
  expect(runtimesSeenBy(alice)).toEqual([
    { chatId: research, startedByName: 'Alice', name: 'Research' },
    { chatId: chatId('chat-invoice-bug'), startedByName: 'Bob', name: 'Invoice bug' },
  ])
  expect(runtimesSeenBy(lee)).toEqual([
    { chatId: research, startedByName: 'Alice', name: null },
    { chatId: chatId('chat-invoice-bug'), startedByName: 'Bob', name: 'Invoice bug' },
  ])
  expect(
    welcomeFor(alice, [], { runtimeOrigins })?.messages.filter((message) => message.runtimes.length > 0),
  ).toHaveLength(1)
})

test('the pull request chip shows the newest card of the chat, also one older than the synced messages', () => {
  const card = (seq: number, number: number) => ({
    ...replyRow(seq, 'step', {
      replyToId: null,
      step: { type: 'pull_request', number, state: 'open', url: `pr/${number}` },
    }),
    authorId: alice,
  })
  const snapshot = snapshotWith({ turn: false, waiting: false })
  const pullRequestWith = (pinnedSteps: Snapshot['pinnedSteps'], messages: Snapshot['messages']) =>
    getConversation(acme, research, alice)({ ...snapshot, pinnedSteps, messages: [...snapshot.messages, ...messages] })
      ?.pullRequest
  expect(pullRequestWith([card(2, 7)], [])).toEqual({ number: 7, state: 'open', url: 'pr/7' })
  expect(pullRequestWith([card(2, 7)], [card(9, 8)])).toEqual({ number: 8, state: 'open', url: 'pr/8' })
  expect(pullRequestWith([], [])).toBeNull()
})
