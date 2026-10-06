import { sql } from 'drizzle-orm'
import {
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
import type { DiffLine, RuntimeFailure, RuntimeHostCapacity, RuntimeState } from '../schema.ts'

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
    mode: text().$type<'dev' | 'non-dev'>(),
    ownerKind: text().$type<'user' | 'service_identity'>().notNull(),
    ownerUserId: text(),
    ownerServiceIdentityId: text(),
    name: text().notNull(),
    model: text(),
    reasoningEffort: text(),
    gitBranch: text(),
    originChatId: text(),
    agentTurnMessageId: text(),
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

export const chatParticipants = table(
  'chat_participants',
  { ...chatScoped, userId: text().notNull(), role: text().notNull() },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.chatId, table.userId] }),
    chatReference(table),
    memberReference(table, table.userId),
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
    kind: text().$type<'member' | 'agent' | 'tool-call' | 'notice'>().notNull(),
    authorId: text(),
    body: text().notNull(),
    detail: text(),
    replyToId: text(),
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

export const placeholderSecrets = table(
  'placeholder_secrets',
  {
    workspaceId: text()
      .notNull()
      .references(() => workspaces.workspaceId),
    ref: text().notNull(),
    value: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.ref] })],
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
      .where(sql`${table.type} like '%.sweep' and ${table.state} = 'queued'`),
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
    createdAt: instant().notNull(),
    removedAt: instant(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.id] }), memberReference(table, table.createdBy)],
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
    apiKeyRef: text(),
    llmTokenRef: text(),
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
  { ...chatScoped, userId: text().notNull(), tokens: integer().notNull(), costCents: integer().notNull() },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.chatId, table.userId] }),
    chatReference(table),
    memberReference(table, table.userId),
  ],
)

export const relations = defineRelations(
  {
    users,
    workspaces,
    memberships,
    projects,
    chats,
    chatParticipants,
    messages,
    readMarkers,
    workspaceConnections,
    toolConnections,
  },
  (r) => ({
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
  }),
)
