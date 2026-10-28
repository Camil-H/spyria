import {
  builtInChatRoles,
  builtInWorkspaceRoles,
  chatId,
  credentialId,
  type MemberId,
  type MessageId,
  memberId,
  messageId,
  type ProjectId,
  projectId,
  visibilityOf,
  type WorkspaceId,
  workspaceId,
} from '@spyria/kernel'
import type { ChatRow, MessageRow, Snapshot } from './schema.ts'

export const acme = workspaceId('workspace-acme')
export const globex = workspaceId('workspace-globex')
export const alice = memberId('member-alice')
export const bob = memberId('member-bob')
export const lee = memberId('member-lee')
const aliceEmail = 'alice@example.com'
const onboarding = projectId('project-onboarding')
const billing = projectId('project-billing')
const launch = projectId('project-launch')

const invoiceChat = chatId('chat-invoice-bug')
const welcomeChat = chatId('chat-welcome')

const currentMonth = () => new Date().toISOString().slice(0, 7)
const invoiceBug = { workspaceId: acme, chatId: invoiceChat }
const toolConnection = (tool: string, status: string) => ({ workspaceId: acme, memberId: alice, tool, status })
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
  visibility: visibilityOf(runtime ? 'runtime' : 'channel'),
  name,
  ownerId,
  archived: false,
  model: runtime?.model ?? null,
  reasoningEffort: runtime?.reasoningEffort ?? null,
  subagentPolicy: 'auto',
  harness: null,
  localSession: false,
  gitBranch: runtime?.gitBranch ?? null,
  repository: null,
  baseBranch: null,
  originChatId: null,
  agentTurnMessageId: null,
  contextTokens: null,
  contextWindow: null,
})
const participant = (chat: string, memberId: MemberId, roleId: string) => ({
  workspaceId: acme,
  chatId: chatId(chat),
  memberId,
  roleId,
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
  attachments: [],
  detail,
  step,
  replyToId: null,
  threadRootId: null,
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

const createChats = () => [
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
]

export const createMockSnapshot = (): Snapshot => {
  const chats = createChats()
  return {
    workspaces: [
      { id: acme, name: 'Acme', localSessions: true },
      { id: globex, name: 'Globex', localSessions: true },
    ],
    memberships: [
      {
        memberId: alice,
        workspaceId: acme,
        displayName: 'Alice',
        avatar: null,
        email: aliceEmail,
        role: 'admin',
        removedAt: null,
      },
      {
        memberId: bob,
        workspaceId: acme,
        displayName: 'Bob',
        avatar: null,
        email: 'bob@example.com',
        role: 'member',
        removedAt: null,
      },
      {
        memberId: lee,
        workspaceId: acme,
        displayName: 'Lee',
        avatar: null,
        email: 'lee@example.com',
        role: 'member',
        removedAt: null,
      },
      {
        memberId: alice,
        workspaceId: globex,
        displayName: 'Alice',
        avatar: null,
        email: aliceEmail,
        role: 'admin',
        removedAt: null,
      },
    ],
    workspaceRoles: [acme, globex].flatMap((workspaceId) =>
      builtInWorkspaceRoles.map((role) => ({ ...role, workspaceId, builtIn: true })),
    ),
    invitations: [],
    projects: [
      { id: onboarding, workspaceId: acme, name: 'Onboarding', archived: false },
      { id: billing, workspaceId: acme, name: 'Billing', archived: false },
      { id: launch, workspaceId: globex, name: 'Launch', archived: false },
    ],
    chats,
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
    latestMessages: [],
    latestAgentActivity: [],
    pinnedSteps: [],
    readMarkers: [
      { workspaceId: acme, memberId: alice, chatId: welcomeChat, lastReadSeq: 2 },
      { workspaceId: acme, memberId: alice, chatId: invoiceChat, lastReadSeq: 4 },
    ],
    threadReadMarkers: [],
    runtimeOrigins: [],
    browserPages: [
      {
        ...invoiceBug,
        url: 'reports/invoice-totals.html',
        title: 'Invoice totals',
        openedAt: '2026-10-01T09:05:00.000Z',
      },
      {
        ...invoiceBug,
        url: 'https://example.com/invoices',
        title: 'Invoices',
        openedAt: '2026-10-01T09:06:00.000Z',
      },
      {
        workspaceId: acme,
        chatId: welcomeChat,
        url: 'https://example.com/onboarding',
        title: 'Onboarding guide',
        openedAt: '2026-10-01T09:00:00.000Z',
      },
    ],
    usageEntries: [
      { ...invoiceBug, month: currentMonth(), memberId: alice, tokens: 12400, costMicros: 180_000, calls: 3 },
      { ...invoiceBug, month: currentMonth(), memberId: bob, tokens: 3100, costMicros: 50_000, calls: 1 },
    ],
    budgetAlerts: [],
    sources: [
      { workspaceId: acme, chatId: welcomeChat, name: 'Employee handbook', origin: 'Onyx' },
      { workspaceId: acme, chatId: welcomeChat, name: 'Onboarding wiki page', origin: 'Wiki' },
    ],
    toolConnections: [
      toolConnection('GitHub', 'Connected'),
      toolConnection('Slack', 'Connected'),
      toolConnection('Notion', 'Needs reconnection'),
    ],
    chatMembers: [
      ...chats.map((chat) => ({
        workspaceId: chat.workspaceId,
        chatId: chat.id,
        memberId: chat.ownerId,
        roleId: 'owner',
      })),
      participant('chat-invoice-bug', bob, 'prompter'),
      participant('chat-welcome', bob, 'prompter'),
      participant('chat-setup-helper', alice, 'prompter'),
      participant('chat-standup', alice, 'prompter'),
      participant('chat-invoice-bug', lee, 'reader'),
    ],
    chatRoles: [acme, globex].flatMap((workspaceId) =>
      builtInChatRoles.map((role) => ({ ...role, workspaceId, builtIn: true })),
    ),
    llmCredentials: [
      {
        id: credentialId('credential-alice-anthropic'),
        workspaceId: acme,
        memberId: alice,
        provider: 'Anthropic',
        last4: 'a1b2',
      },
    ],
    workspaceConnections: [],
    connectionRestrictions: [],
    runtimeHosts: [],
    runtimes: [],
  }
}
