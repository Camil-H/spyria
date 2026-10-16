import {
  chatId,
  credentialId,
  type MemberId,
  type MessageId,
  memberId,
  messageId,
  type ProjectId,
  projectId,
  type WorkspaceId,
  workspaceId,
} from '@hq/kernel'
import type { ChangeRow, ChatRow, FileRow, MessageRow, Snapshot } from './schema.ts'

export const acme = workspaceId('workspace-acme')
export const globex = workspaceId('workspace-globex')
export const alice = memberId('member-alice')
export const bob = memberId('member-bob')
const onboarding = projectId('project-onboarding')
const billing = projectId('project-billing')
const launch = projectId('project-launch')

const invoiceChat = chatId('chat-invoice-bug')
const welcomeChat = chatId('chat-welcome')

const currentMonth = () => new Date().toISOString().slice(0, 7)
const invoiceBug = { workspaceId: acme, chatId: invoiceChat }
const file = (path: string, kind: FileRow['kind'] = 'file'): FileRow => ({ ...invoiceBug, path, kind })
const change = (path: string, additions: number, deletions: number, diffLines: ChangeRow['diffLines']): ChangeRow => ({
  ...invoiceBug,
  path,
  additions,
  deletions,
  diffLines,
})
const terminalLine = (text: string) => ({ ...invoiceBug, text })
const planStep = (title: string, status: string) => ({ ...invoiceBug, title, status })
const toolConnection = (tool: string, status: string) => ({ workspaceId: acme, memberId: alice, tool, status })
const workspaceConnection = (memberId: MemberId, tool: string, access: string) => ({
  workspaceId: acme,
  memberId,
  tool,
  access,
})
const chat = (
  id: string,
  workspace: WorkspaceId,
  project: ProjectId | null,
  name: string,
  ownerId: MemberId,
  runtime?: { model: string | null; reasoningEffort: string | null; gitBranch: string | null },
): ChatRow => ({
  id: chatId(id),
  workspaceId: workspace,
  projectId: project,
  type: runtime ? 'runtime' : 'channel',
  name,
  ownerId,
  archived: false,
  model: runtime?.model ?? null,
  reasoningEffort: runtime?.reasoningEffort ?? null,
  subagentPolicy: 'auto',
  harness: null,
  localSession: false,
  isPlanning: false,
  gitBranch: runtime?.gitBranch ?? null,
  originChatId: null,
  agentTurnMessageId: null,
})
const bobCanPrompt = (chat: string) => ({
  workspaceId: acme,
  chatId: chatId(chat),
  memberId: bob,
  role: 'Can prompt',
})

const message = (
  id: string,
  chat: string,
  workspace: WorkspaceId,
  authorId: MemberId | null,
  kind: MessageRow['kind'],
  body: string,
  time: string,
  detail: string | null = null,
  step: MessageRow['step'] = null,
): MessageRow => ({
  id: messageId(`message-${id}`),
  workspaceId: workspace,
  chatId: chatId(chat),
  seq: Number(id.slice(id.lastIndexOf('-') + 1)),
  kind,
  authorId,
  body,
  detail,
  step,
  replyToId: null,
  createdAt: `2026-09-30T${time}:00.000Z`,
  editedAt: null,
  deletedAt: null,
  needsReply: false,
})
const member = (id: string, chat: string, workspace: WorkspaceId, author: MemberId, body: string, time: string) =>
  message(id, chat, workspace, author, 'member', body, time)
const agent = (id: string, chat: string, workspace: WorkspaceId, body: string, time: string) =>
  message(id, chat, workspace, null, 'agent', body, time)
const command = (id: string, chat: string, workspace: WorkspaceId, body: string, time: string, output: string) =>
  message(id, chat, workspace, null, 'step', body, time, null, {
    type: 'command',
    command: body,
    exitCode: null,
    durationMilliseconds: null,
    output,
    truncatedLines: 0,
  })

const withReplyTargets = (messages: readonly MessageRow[]) => {
  const answeredMessageIdByChat = new Map<string, MessageId | null>()
  return messages.map((message) => {
    if (message.kind === 'member') answeredMessageIdByChat.set(message.chatId, message.needsReply ? null : message.id)
    const answeredMessageId = answeredMessageIdByChat.get(message.chatId)
    if (message.kind !== 'agent' || !answeredMessageId) return message
    answeredMessageIdByChat.set(message.chatId, null)
    return { ...message, replyToId: answeredMessageId }
  })
}

export const createMockSnapshot = (): Snapshot => ({
  workspaces: [
    { id: acme, name: 'Acme', localSessions: true },
    { id: globex, name: 'Globex', localSessions: true },
  ],
  memberships: [
    { memberId: alice, workspaceId: acme, displayName: 'Alice', role: 'admin' },
    { memberId: bob, workspaceId: acme, displayName: 'Bob', role: 'member' },
    { memberId: alice, workspaceId: globex, displayName: 'Alice', role: 'admin' },
  ],
  projects: [
    { id: onboarding, workspaceId: acme, name: 'Onboarding', archived: false },
    { id: billing, workspaceId: acme, name: 'Billing', archived: false },
    { id: launch, workspaceId: globex, name: 'Launch', archived: false },
  ],
  chats: [
    chat('chat-welcome', acme, onboarding, 'Welcome', alice),
    chat('chat-setup-helper', acme, onboarding, 'Setup helper', bob, {
      model: 'openai/gpt-5',
      reasoningEffort: 'medium',
      gitBranch: 'main',
    }),
    chat('chat-invoice-bug', acme, billing, 'Invoice bug', alice, {
      model: 'anthropic/claude-sonnet-5-5',
      reasoningEffort: 'high',
      gitBranch: 'fix/invoice-tax',
    }),
    chat('chat-standup', acme, null, 'Standup', bob),
    chat('chat-research', acme, null, 'Research', alice, {
      model: null,
      reasoningEffort: null,
      gitBranch: null,
    }),
    chat('chat-launch-plan', globex, launch, 'Launch plan', alice, {
      model: null,
      reasoningEffort: null,
      gitBranch: null,
    }),
    chat('chat-general', globex, null, 'General', alice),
  ],
  messages: withReplyTargets([
    member('welcome-1', 'chat-welcome', acme, bob, 'Welcome to the team!', '09:00'),
    member('welcome-2', 'chat-welcome', acme, alice, 'Thanks, glad to be here.', '09:02'),
    member('standup-1', 'chat-standup', acme, bob, 'Standup at 10.', '09:30'),
    member('general-1', 'chat-general', globex, alice, 'Hello Globex.', '08:00'),
    member('setup-1', 'chat-setup-helper', acme, bob, 'Set up the dev environment.', '10:00'),
    agent('setup-2', 'chat-setup-helper', acme, "I'll install the dependencies first.", '10:01'),
    command('setup-3', 'chat-setup-helper', acme, 'Ran: bun install', '10:02', 'Done in 35s'),
    agent('setup-4', 'chat-setup-helper', acme, 'Dependencies installed.', '10:03'),
    member('invoice-1', 'chat-invoice-bug', acme, alice, 'Why do invoices show the wrong total?', '11:00'),
    agent('invoice-2', 'chat-invoice-bug', acme, 'Checking the invoice calculation.', '11:01'),
    command('invoice-3', 'chat-invoice-bug', acme, 'Read: billing/invoice.ts', '11:02', 'export const total = ...'),
    agent('invoice-4', 'chat-invoice-bug', acme, 'The tax is applied twice.', '11:03'),
  ]),
  drafts: [],
  readMarkers: [
    { workspaceId: acme, memberId: alice, chatId: welcomeChat, lastReadSeq: 2 },
    { workspaceId: acme, memberId: alice, chatId: invoiceChat, lastReadSeq: 4 },
  ],
  files: [
    file('billing', 'folder'),
    file('billing/invoice.ts'),
    file('billing/tax.ts'),
    file('tests', 'folder'),
    file('tests/invoice.test.ts'),
    file('package.json'),
  ],
  changes: [
    change('billing/tax.ts', 3, 5, [
      { kind: 'context', text: 'export const invoiceTotal = (net: number) => {' },
      { kind: 'removed', text: 'const total = applyTax(applyTax(net))' },
      { kind: 'added', text: 'const total = applyTax(net)' },
      { kind: 'context', text: 'return total' },
    ]),
    change('tests/invoice.test.ts', 12, 0, [{ kind: 'added', text: "test('applies tax once', () => {})" }]),
  ],
  terminalLines: [terminalLine('$ bun test'), terminalLine('3 pass'), terminalLine('0 fail')],
  planSteps: [
    planStep('Reproduce the bug', 'done'),
    planStep('Fix the tax calculation', 'in-progress'),
    planStep('Add a regression test', 'todo'),
  ],
  commits: [
    {
      ...invoiceBug,
      sha: 'a1b2c3d',
      message: 'Fix tax applied twice',
      authorId: alice,
      committedAt: '2026-09-30T11:20:00.000Z',
    },
  ],
  browserPages: [
    {
      ...invoiceBug,
      url: 'http://localhost:3000/invoices',
      title: 'Invoices',
      bodyText: 'Invoice total: 120.00',
    },
    {
      workspaceId: acme,
      chatId: welcomeChat,
      url: 'https://example.com/onboarding',
      title: 'Onboarding guide',
      bodyText: 'Welcome to the team.',
    },
  ],
  usageEntries: [
    { ...invoiceBug, month: currentMonth(), memberId: alice, tokens: 12400, costMicros: 180_000, calls: 3 },
    { ...invoiceBug, month: currentMonth(), memberId: bob, tokens: 3100, costMicros: 50_000, calls: 1 },
  ],
  sources: [
    { workspaceId: acme, chatId: welcomeChat, name: 'Employee handbook', origin: 'Onyx' },
    { workspaceId: acme, chatId: welcomeChat, name: 'Onboarding wiki page', origin: 'Wiki' },
  ],
  toolConnections: [
    toolConnection('GitHub', 'Connected'),
    toolConnection('Slack', 'Connected'),
    toolConnection('Notion', 'Needs reconnection'),
  ],
  chatMembers: [bobCanPrompt('chat-invoice-bug'), bobCanPrompt('chat-welcome')],
  llmCredentials: [
    {
      id: credentialId('credential-alice-anthropic'),
      workspaceId: acme,
      memberId: alice,
      provider: 'Anthropic',
      last4: 'a1b2',
    },
  ],
  workspaceConnections: [
    workspaceConnection(alice, 'Postgres', '2 of 5 tables'),
    workspaceConnection(alice, 'Onyx', 'All sources'),
    workspaceConnection(bob, 'Postgres', '1 of 5 tables'),
  ],
  runtimeHosts: [],
  runtimes: [],
})
