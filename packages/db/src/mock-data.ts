import {
  chatId,
  credentialId,
  type MemberId,
  memberId,
  messageId,
  type ProjectId,
  projectId,
  type WorkspaceId,
  workspaceId,
} from '@hq/kernel'
import type { ChangeRow, ChatRow, FileRow, MessageRow, Snapshot } from './schema.ts'

const acme = workspaceId('workspace-acme')
const globex = workspaceId('workspace-globex')
const alice = memberId('member-alice')
const bob = memberId('member-bob')
const onboarding = projectId('project-onboarding')
const billing = projectId('project-billing')
const launch = projectId('project-launch')

const invoiceChat = chatId('chat-invoice-bug')
const welcomeChat = chatId('chat-welcome')

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
  runtime?: { model: string; reasoningEffort: string; gitBranch: string | null },
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
  gitBranch: runtime?.gitBranch ?? null,
  originChatId: null,
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
): MessageRow => ({
  id: messageId(`message-${id}`),
  workspaceId: workspace,
  chatId: chatId(chat),
  seq: Number(id.slice(id.lastIndexOf('-') + 1)),
  kind,
  authorId,
  body,
  detail,
  createdAt: `2026-09-30T${time}:00.000Z`,
  editedAt: null,
  deletedAt: null,
  needsReply: false,
})
const member = (id: string, chat: string, workspace: WorkspaceId, author: MemberId, body: string, time: string) =>
  message(id, chat, workspace, author, 'member', body, time)
const agent = (
  id: string,
  chat: string,
  workspace: WorkspaceId,
  kind: 'agent' | 'tool-call',
  body: string,
  time: string,
  detail: string | null = null,
) => message(id, chat, workspace, null, kind, body, time, detail)

export const createMockSnapshot = (): Snapshot => ({
  workspaces: [
    { id: acme, name: 'Acme' },
    { id: globex, name: 'Globex' },
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
      model: 'GPT-5',
      reasoningEffort: 'Medium',
      gitBranch: 'main',
    }),
    chat('chat-invoice-bug', acme, billing, 'Invoice bug', alice, {
      model: 'Claude Sonnet 5.5',
      reasoningEffort: 'High',
      gitBranch: 'fix/invoice-tax',
    }),
    chat('chat-standup', acme, null, 'Standup', bob),
    chat('chat-research', acme, null, 'Research', alice, {
      model: 'Claude Sonnet 5.5',
      reasoningEffort: 'Medium',
      gitBranch: null,
    }),
    chat('chat-launch-plan', globex, launch, 'Launch plan', alice, {
      model: 'Claude Sonnet 5.5',
      reasoningEffort: 'Medium',
      gitBranch: null,
    }),
    chat('chat-general', globex, null, 'General', alice),
  ],
  messages: [
    member('welcome-1', 'chat-welcome', acme, bob, 'Welcome to the team!', '09:00'),
    member('welcome-2', 'chat-welcome', acme, alice, 'Thanks, glad to be here.', '09:02'),
    member('standup-1', 'chat-standup', acme, bob, 'Standup at 10.', '09:30'),
    member('general-1', 'chat-general', globex, alice, 'Hello Globex.', '08:00'),
    member('setup-1', 'chat-setup-helper', acme, bob, 'Set up the dev environment.', '10:00'),
    agent('setup-2', 'chat-setup-helper', acme, 'agent', "I'll install the dependencies first.", '10:01'),
    agent('setup-3', 'chat-setup-helper', acme, 'tool-call', 'Ran: bun install', '10:02', 'Done in 35s'),
    agent('setup-4', 'chat-setup-helper', acme, 'agent', 'Dependencies installed.', '10:03'),
    member('invoice-1', 'chat-invoice-bug', acme, alice, 'Why do invoices show the wrong total?', '11:00'),
    agent('invoice-2', 'chat-invoice-bug', acme, 'agent', 'Checking the invoice calculation.', '11:01'),
    agent(
      'invoice-3',
      'chat-invoice-bug',
      acme,
      'tool-call',
      'Read: billing/invoice.ts',
      '11:02',
      'export const total = ...',
    ),
    agent('invoice-4', 'chat-invoice-bug', acme, 'agent', 'The tax is applied twice.', '11:03'),
  ],
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
    { ...invoiceBug, memberId: alice, tokens: 12400, costCents: 18 },
    { ...invoiceBug, memberId: bob, tokens: 3100, costCents: 5 },
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
