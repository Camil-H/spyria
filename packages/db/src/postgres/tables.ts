import type { ChatPermission, ChatVisibility } from '@hq/kernel'
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  type PgColumn,
  primaryKey,
  snakeCase,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { defineRelations } from 'drizzle-orm/relations'
import type { DiffLine, MessageStep, RuntimeFailure, RuntimeHostCapacity, RuntimeState } from '../schema.ts'

const table = snakeCase.table
const instant = () => timestamp({ withTimezone: true, mode: 'date' })
const tenant = { workspaceId: text().notNull() }
const chatScoped = { ...tenant, chatId: text().notNull() }
const tenantReference = (columns: [PgColumn, PgColumn], foreignColumns: [PgColumn, PgColumn]) =>
  foreignKey({ columns, foreignColumns })

export const users = table('users', {
  id: text().primaryKey(),
  email: text().notNull().unique(),
})

export const workspaces = table('workspaces', {
  workspaceId: text().primaryKey(),
  name: text().notNull(),
  createdBy: text()
    .notNull()
    .references(() => users.id),
  localSessions: boolean().notNull().default(true),
  createdAt: instant().notNull(),
})

export const memberships = table(
  'memberships',
  {
    workspaceId: text()
      .notNull()
      .references(() => workspaces.workspaceId),
    userId: text()
      .notNull()
      .references(() => users.id),
    role: text().$type<'admin' | 'member'>().notNull(),
    displayName: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.userId] })],
)

const memberReference = (table: { workspaceId: PgColumn }, userColumn: PgColumn) =>
  tenantReference([table.workspaceId, userColumn], [memberships.workspaceId, memberships.userId])

export const identities = table(
  'identities',
  { ...tenant, issuer: text().notNull(), subject: text().notNull(), userId: text().notNull() },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.issuer, table.subject] }),
    memberReference(table, table.userId),
  ],
)

export const sessions = table(
  'sessions',
  {
    ...tenant,
    id: text().notNull(),
    userId: text().notNull(),
    createdAt: instant().notNull(),
    expiresAt: instant().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    memberReference(table, table.userId).onDelete('cascade'),
  ],
)

export const serviceIdentities = table(
  'service_identities',
  {
    workspaceId: text()
      .notNull()
      .references(() => workspaces.workspaceId),
    id: text().notNull(),
    name: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.id] })],
)

export const projects = table(
  'projects',
  {
    workspaceId: text()
      .notNull()
      .references(() => workspaces.workspaceId),
    id: text().notNull(),
    name: text().notNull(),
    archived: boolean().notNull(),
    createdAt: instant().notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.id] })],
)

export const chats = table(
  'chats',
  {
    ...tenant,
    id: text().notNull(),
    projectId: text(),
    type: text().$type<'channel' | 'runtime'>().notNull(),
    visibility: text().$type<ChatVisibility>().notNull(),
    mode: text().$type<'dev' | 'non-dev'>(),
    ownerKind: text().$type<'user' | 'service_identity'>().notNull(),
    ownerUserId: text(),
    ownerServiceIdentityId: text(),
    name: text().notNull(),
    model: text(),
    reasoningEffort: text(),
    subagentPolicy: text().$type<'auto' | 'same_as_main'>().notNull().default('auto'),
    agentModel: text(),
    agentReasoningEffort: text(),
    harness: text().$type<'claude-code' | 'codex'>(),
    localSession: boolean().default(false),
    isPlanning: boolean().notNull().default(false),
    gitBranch: text(),
    originChatId: text(),
    agentTurnMessageId: text(),
    agentTurnPrompterId: text(),
    agentTurnFailure: text(),
    archived: boolean().notNull(),
    createdAt: instant().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    tenantReference([table.workspaceId, table.projectId], [projects.workspaceId, projects.id]),
    memberReference(table, table.ownerUserId),
    tenantReference(
      [table.workspaceId, table.ownerServiceIdentityId],
      [serviceIdentities.workspaceId, serviceIdentities.id],
    ),
    tenantReference([table.workspaceId, table.originChatId], [table.workspaceId, table.id]),
    check(
      'chats_owner_matches_kind',
      sql`(${table.ownerKind} = 'user' and ${table.ownerUserId} is not null and ${table.ownerServiceIdentityId} is null) or (${table.ownerKind} = 'service_identity' and ${table.ownerServiceIdentityId} is not null and ${table.ownerUserId} is null)`,
    ),
  ],
)

const chatReference = (table: { workspaceId: PgColumn; chatId: PgColumn }) =>
  tenantReference([table.workspaceId, table.chatId], [chats.workspaceId, chats.id])

export const chatRoles = table(
  'chat_roles',
  {
    workspaceId: text()
      .notNull()
      .references(() => workspaces.workspaceId),
    id: text().notNull(),
    name: text().notNull(),
    permissions: text().$type<ChatPermission>().array().notNull(),
    builtIn: boolean().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    check('chat_roles_permissions_read', sql`'chat.read' = any(${table.permissions})`),
  ],
)

export const chatParticipants = table(
  'chat_participants',
  { ...chatScoped, userId: text().notNull(), roleId: text().notNull() },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.chatId, table.userId] }),
    chatReference(table),
    memberReference(table, table.userId),
    tenantReference([table.workspaceId, table.roleId], [chatRoles.workspaceId, chatRoles.id]),
  ],
)

export const events = table(
  'events',
  {
    ...chatScoped,
    id: text().notNull(),
    seq: integer().notNull(),
    type: text().notNull(),
    actor: text(),
    payload: jsonb().notNull(),
    createdAt: instant().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    unique().on(table.chatId, table.seq),
    chatReference(table),
  ],
)

export const messages = table(
  'messages',
  {
    ...chatScoped,
    id: text().notNull(),
    seq: integer().notNull(),
    kind: text().$type<'member' | 'agent' | 'step' | 'notice'>().notNull(),
    authorId: text(),
    body: text().notNull(),
    detail: text(),
    step: jsonb().$type<MessageStep>(),
    replyToId: text(),
    threadRootId: text(),
    createdAt: instant().notNull(),
    editedAt: instant(),
    deletedAt: instant(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    unique().on(table.chatId, table.seq),
    chatReference(table),
    memberReference(table, table.authorId),
    tenantReference([table.workspaceId, table.replyToId], [table.workspaceId, table.id]),
    tenantReference([table.workspaceId, table.threadRootId], [table.workspaceId, table.id]),
  ],
)

export const readMarkers = table(
  'read_markers',
  { ...chatScoped, userId: text().notNull(), lastReadSeq: integer().notNull() },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId, table.chatId] }),
    chatReference(table),
    memberReference(table, table.userId),
  ],
)

export const threadReadMarkers = table(
  'thread_read_markers',
  { ...chatScoped, userId: text().notNull(), threadRootId: text().notNull(), lastReadSeq: integer().notNull() },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId, table.threadRootId] }),
    chatReference(table),
    memberReference(table, table.userId),
    tenantReference([table.workspaceId, table.threadRootId], [messages.workspaceId, messages.id]),
  ],
)

export const runtimeOrigins = table(
  'runtime_origins',
  { ...chatScoped, runtimeChatId: text().notNull(), messageId: text().notNull(), startedBy: text().notNull() },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.runtimeChatId] }),
    chatReference(table),
    tenantReference([table.workspaceId, table.runtimeChatId], [chats.workspaceId, chats.id]),
    tenantReference([table.workspaceId, table.messageId], [messages.workspaceId, messages.id]),
    memberReference(table, table.startedBy),
  ],
)

export const llmCredentials = table(
  'llm_credentials',
  {
    ...tenant,
    id: text().notNull(),
    userId: text().notNull(),
    provider: text().notNull(),
    last4: text().notNull(),
    secretRef: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.id] }), memberReference(table, table.userId)],
)

export const memberGatewayKeys = table(
  'member_gateway_keys',
  { ...tenant, userId: text().notNull(), virtualKeyId: text().notNull() },
  (table) => [primaryKey({ columns: [table.workspaceId, table.userId] }), memberReference(table, table.userId)],
)

export const workspaceConnections = table(
  'workspace_connections',
  {
    ...tenant,
    userId: text().notNull(),
    tool: text().notNull(),
    access: text().notNull(),
    position: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId, table.tool] }),
    memberReference(table, table.userId),
  ],
)

export const toolConnections = table(
  'tool_connections',
  {
    ...tenant,
    userId: text().notNull(),
    tool: text().notNull(),
    status: text().notNull(),
    position: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId, table.tool] }),
    unique().on(table.workspaceId, table.userId, table.position),
    memberReference(table, table.userId),
  ],
)

export const jobs = table(
  'jobs',
  {
    workspaceId: text()
      .notNull()
      .references(() => workspaces.workspaceId),
    id: text().notNull(),
    type: text().notNull(),
    payload: jsonb().notNull(),
    runAt: instant().notNull(),
    attempts: integer().notNull(),
    state: text().$type<'queued' | 'running' | 'done' | 'failed'>().notNull(),
    lastError: text(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    index().on(table.state, table.runAt),
    uniqueIndex('jobs_one_queued_sweep')
      .on(table.workspaceId, table.type)
      .where(sql`(${table.type} like '%.sweep' or ${table.type} = 'usage.sync') and ${table.state} = 'queued'`),
  ],
)

export const runtimeHosts = table(
  'runtime_hosts',
  {
    ...tenant,
    id: text().notNull(),
    name: text().notNull(),
    claimCodeHash: text().unique(),
    claimExpiresAt: instant(),
    tokenHash: text().unique(),
    status: text().$type<'waiting' | 'online' | 'offline' | 'expired'>().notNull(),
    capacity: jsonb().$type<RuntimeHostCapacity>(),
    runningRuntimes: integer().notNull(),
    lastSeenAt: instant(),
    createdBy: text().notNull(),
    ownerId: text(),
    createdAt: instant().notNull(),
    removedAt: instant(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    memberReference(table, table.createdBy),
    memberReference(table, table.ownerId),
    uniqueIndex('runtime_hosts_one_machine_per_member')
      .on(table.workspaceId, table.ownerId)
      .where(sql`${table.removedAt} is null`),
  ],
)

export const runtimes = table(
  'runtimes',
  {
    ...chatScoped,
    id: text().notNull(),
    hostId: text(),
    state: text().$type<RuntimeState>().notNull(),
    failure: text().$type<RuntimeFailure>(),
    hostOnline: boolean().notNull().default(false),
    image: text().notNull(),
    apiKey: text(),
    llmTokenHash: text(),
    llmSwitchTokenHash: text(),
    agentConversationId: text(),
    lastActiveAt: instant().notNull(),
    createdAt: instant().notNull(),
    stateChangedAt: instant().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    unique().on(table.workspaceId, table.chatId),
    chatReference(table),
    tenantReference([table.workspaceId, table.hostId], [runtimeHosts.workspaceId, runtimeHosts.id]),
  ],
)

export const files = table(
  'files',
  { ...chatScoped, path: text().notNull(), kind: text().$type<'file' | 'folder'>().notNull() },
  (table) => [primaryKey({ columns: [table.workspaceId, table.chatId, table.path] }), chatReference(table)],
)

export const changes = table(
  'changes',
  {
    ...chatScoped,
    path: text().notNull(),
    additions: integer().notNull(),
    deletions: integer().notNull(),
    diffLines: jsonb().$type<readonly DiffLine[]>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.chatId, table.path] }), chatReference(table)],
)

export const terminalLines = table(
  'terminal_lines',
  { ...chatScoped, position: integer().notNull(), text: text().notNull() },
  (table) => [primaryKey({ columns: [table.workspaceId, table.chatId, table.position] }), chatReference(table)],
)

export const planSteps = table(
  'plan_steps',
  { ...chatScoped, position: integer().notNull(), title: text().notNull(), status: text().notNull() },
  (table) => [primaryKey({ columns: [table.workspaceId, table.chatId, table.position] }), chatReference(table)],
)

export const commits = table(
  'commits',
  {
    ...chatScoped,
    sha: text().notNull(),
    message: text().notNull(),
    authorId: text().notNull(),
    committedAt: instant().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.chatId, table.sha] }),
    chatReference(table),
    memberReference(table, table.authorId),
  ],
)

export const browserPages = table(
  'browser_pages',
  { ...chatScoped, url: text().notNull(), title: text().notNull(), bodyText: text().notNull() },
  (table) => [primaryKey({ columns: [table.workspaceId, table.chatId, table.url] }), chatReference(table)],
)

export const sources = table(
  'sources',
  { ...chatScoped, name: text().notNull(), origin: text().notNull() },
  (table) => [primaryKey({ columns: [table.workspaceId, table.chatId, table.name] }), chatReference(table)],
)

export const usageEntries = table(
  'usage_entries',
  {
    ...chatScoped,
    month: text().notNull(),
    userId: text().notNull(),
    tokens: integer().notNull(),
    costMicros: bigint({ mode: 'number' }).notNull(),
    calls: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.month, table.chatId, table.userId] }),
    chatReference(table),
    memberReference(table, table.userId),
  ],
)

export const modelCalls = table(
  'model_calls',
  {
    workspaceId: text()
      .notNull()
      .references(() => workspaces.workspaceId),
    id: text().notNull(),
    chatId: text().notNull(),
    prompterId: text().notNull(),
    ownerId: text(),
    model: text().notNull(),
    provider: text().notNull(),
    inputTokens: integer().notNull(),
    outputTokens: integer().notNull(),
    costMicros: integer().notNull(),
    status: text().$type<'success' | 'error'>().notNull(),
    role: text(),
    calledAt: instant().notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.id] })],
)

export const toolCalls = table(
  'tool_calls',
  {
    ...chatScoped,
    id: text().notNull(),
    prompterId: text().notNull(),
    ownerId: text().notNull(),
    server: text().notNull(),
    tool: text().notNull(),
    readOnly: boolean(),
    decision: text().$type<'not_needed' | 'approved' | 'denied' | 'expired' | 'cancelled'>().notNull(),
    decidedBy: text(),
    status: text().$type<'succeeded' | 'failed' | 'refused'>().notNull(),
    calledAt: instant().notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.id] }), chatReference(table)],
)

export const routingDecisions = table(
  'routing_decisions',
  {
    ...chatScoped,
    id: text().notNull(),
    conversationId: text(),
    role: text().$type<'session' | 'manual'>().notNull(),
    memberId: text().notNull(),
    inputsDigest: text(),
    classifierOutput: jsonb(),
    model: text().notNull(),
    reason: text().notNull(),
    costMicros: integer().notNull(),
    createdAt: instant().notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.id] }), chatReference(table)],
)

export const delegations = table(
  'delegations',
  {
    ...chatScoped,
    id: text().notNull(),
    promptId: text().notNull(),
    conversationId: text(),
    actionEventId: text(),
    task: text().notNull(),
    effortHint: text().notNull(),
    directive: text(),
    policy: text().notNull(),
    classifierOutput: jsonb(),
    model: text().notNull(),
    reason: text().notNull(),
    status: text().$type<'running' | 'finished' | 'failed' | 'stopped'>().notNull(),
    escalatedFrom: text(),
    tokenHash: text().notNull(),
    createdAt: instant().notNull(),
    finishedAt: instant(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    chatReference(table),
    uniqueIndex().on(table.tokenHash),
  ],
)

export const usageSyncMarks = table('usage_sync_marks', {
  workspaceId: text()
    .primaryKey()
    .references(() => workspaces.workspaceId),
  logsSince: instant().notNull(),
})

export const relations = defineRelations(
  {
    users,
    workspaces,
    memberships,
    projects,
    chats,
    chatRoles,
    chatParticipants,
    messages,
    readMarkers,
    threadReadMarkers,
    runtimeOrigins,
    workspaceConnections,
    toolConnections,
    files,
    changes,
    terminalLines,
    planSteps,
    commits,
    browserPages,
    sources,
    usageEntries,
    runtimes,
  },
  (r) => {
    const chatOf = (scoped: { workspaceId: unknown; chatId: unknown }) =>
      r.one.chats({ from: [scoped.workspaceId, scoped.chatId] as never, to: [r.chats.workspaceId, r.chats.id] })
    return {
      users: {
        memberships: r.many.memberships({ from: r.users.id, to: r.memberships.userId }),
      },
      workspaces: {
        memberships: r.many.memberships({ from: r.workspaces.workspaceId, to: r.memberships.workspaceId }),
      },
      workspaceConnections: {
        ownedChats: r.many.chats({
          from: [r.workspaceConnections.workspaceId, r.workspaceConnections.userId],
          to: [r.chats.workspaceId, r.chats.ownerUserId],
        }),
      },
      toolConnections: {
        ownedChats: r.many.chats({
          from: [r.toolConnections.workspaceId, r.toolConnections.userId],
          to: [r.chats.workspaceId, r.chats.ownerUserId],
        }),
      },
      chats: {
        participants: r.many.chatParticipants({
          from: [r.chats.workspaceId, r.chats.id],
          to: [r.chatParticipants.workspaceId, r.chatParticipants.chatId],
        }),
      },
      chatParticipants: {
        chat: chatOf(r.chatParticipants),
        role: r.one.chatRoles({
          from: [r.chatParticipants.workspaceId, r.chatParticipants.roleId],
          to: [r.chatRoles.workspaceId, r.chatRoles.id],
        }),
      },
      messages: { chat: chatOf(r.messages) },
      readMarkers: { chat: chatOf(r.readMarkers) },
      threadReadMarkers: { chat: chatOf(r.threadReadMarkers) },
      runtimeOrigins: { chat: chatOf(r.runtimeOrigins) },
      files: { chat: chatOf(r.files) },
      changes: { chat: chatOf(r.changes) },
      terminalLines: { chat: chatOf(r.terminalLines) },
      planSteps: { chat: chatOf(r.planSteps) },
      commits: { chat: chatOf(r.commits) },
      browserPages: { chat: chatOf(r.browserPages) },
      sources: { chat: chatOf(r.sources) },
      usageEntries: { chat: chatOf(r.usageEntries) },
      runtimes: { chat: chatOf(r.runtimes) },
    }
  },
)
