import {
  type ActorKind,
  type AiProviderAllowList,
  actorKinds,
  type ChatPermission,
  type ChatVisibility,
  type DevLoopSettings,
  type HarnessId,
  type SetupCommand,
  type WorkspacePermission,
} from '@spyria/kernel'
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  bytea,
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
import type { MessageAttachment, MessageStep, RuntimeFailure, RuntimeHostCapacity, RuntimeState } from '../schema.ts'

const table = snakeCase.table
const auditedChatEventTypes = [
  'member.invited',
  'member.joined',
  'member.role_changed',
  'member.removed',
  'member.left',
  'chat.visibility_changed',
  'chat.created',
  'branch.pushed',
]
const instant = () => timestamp({ withTimezone: true, mode: 'date' })
const tenant = { workspaceId: text().notNull() }
const chatScoped = { ...tenant, chatId: text().notNull() }
const tenantReference = (columns: [PgColumn, PgColumn], foreignColumns: [PgColumn, PgColumn]) =>
  foreignKey({ columns, foreignColumns })

const actorColumns = { actorKind: text().$type<ActorKind>(), onBehalfOf: text() }
const knownActorKind = (name: string, kind: PgColumn) =>
  check(name, sql`${kind} in (${sql.raw(actorKinds.map((actorKind) => `'${actorKind}'`).join(', '))})`)

const normalizedEmail = (name: string, email: PgColumn) => check(name, sql`${email} = lower(btrim(${email}))`)

export const users = table(
  'users',
  {
    id: text().primaryKey(),
    email: text().notNull().unique(),
  },
  (table) => [normalizedEmail('users_email_normalized', table.email)],
)

export const workspaces = table('workspaces', {
  workspaceId: text().primaryKey(),
  name: text().notNull(),
  createdBy: text()
    .notNull()
    .references(() => users.id),
  localSessions: boolean().notNull().default(true),
  aiProviderAllowList: jsonb().$type<AiProviderAllowList>(),
  devLoop: jsonb().$type<DevLoopSettings>(),
  setupCommands: jsonb().$type<readonly SetupCommand[]>(),
  createdAt: instant().notNull(),
  deletedAt: instant(),
  purgeAt: instant(),
})

export const workspaceRoles = table(
  'workspace_roles',
  {
    workspaceId: text()
      .notNull()
      .references(() => workspaces.workspaceId),
    id: text().notNull(),
    name: text().notNull(),
    builtIn: boolean().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    uniqueIndex('workspace_roles_name_index').on(table.workspaceId, sql`lower(${table.name})`),
  ],
)

export const workspaceRolePermissions = table(
  'workspace_role_permissions',
  {
    workspaceId: text().notNull(),
    roleId: text().notNull(),
    permission: text().$type<WorkspacePermission>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.roleId, table.permission] }),
    tenantReference([table.workspaceId, table.roleId], [workspaceRoles.workspaceId, workspaceRoles.id]).onDelete(
      'cascade',
    ),
  ],
)

export const memberships = table(
  'memberships',
  {
    workspaceId: text()
      .notNull()
      .references(() => workspaces.workspaceId),
    userId: text()
      .notNull()
      .references(() => users.id),
    role: text().notNull(),
    displayName: text().notNull(),
    avatar: text(),
    removedAt: instant(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    tenantReference([table.workspaceId, table.role], [workspaceRoles.workspaceId, workspaceRoles.id]),
  ],
)

const memberReference = (table: { workspaceId: PgColumn }, userColumn: PgColumn) =>
  tenantReference([table.workspaceId, userColumn], [memberships.workspaceId, memberships.userId])

export const invitations = table(
  'invitations',
  {
    workspaceId: text()
      .notNull()
      .references(() => workspaces.workspaceId),
    id: text().notNull(),
    email: text().notNull(),
    role: text().notNull(),
    invitedBy: text().notNull(),
    createdAt: instant().notNull(),
    expiresAt: instant().notNull(),
    revokedAt: instant(),
    acceptedAt: instant(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    memberReference(table, table.invitedBy),
    normalizedEmail('invitations_email_normalized', table.email),
    uniqueIndex('invitations_one_pending_per_email')
      .on(table.workspaceId, table.email)
      .where(sql`${table.revokedAt} is null and ${table.acceptedAt} is null`),
    index().on(table.email),
  ],
)

export const workspaceEvents = table(
  'workspace_events',
  {
    workspaceId: text()
      .notNull()
      .references(() => workspaces.workspaceId),
    id: text().notNull(),
    type: text().notNull(),
    actorId: text(),
    ...actorColumns,
    payload: jsonb().notNull(),
    createdAt: instant().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    index('workspace_events_created_at_index').on(table.workspaceId, table.createdAt),
    index('workspace_events_actor_index').on(table.workspaceId, table.actorId, table.createdAt),
    index('workspace_events_on_behalf_of_index').on(table.workspaceId, table.onBehalfOf, table.createdAt),
    knownActorKind('workspace_events_actor_kind', table.actorKind),
  ],
)

export const auditSettings = table(
  'audit_settings',
  {
    workspaceId: text()
      .primaryKey()
      .references(() => workspaces.workspaceId),
    retentionDays: integer(),
  },
  (table) => [check('audit_settings_retention_days', sql`${table.retentionDays} between 1 and 36500`)],
)

export const identities = table(
  'identities',
  { ...tenant, issuer: text().notNull(), subject: text().notNull(), userId: text().notNull() },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.issuer, table.subject] }),
    index('identities_issuer_subject_index').on(table.issuer, table.subject),
    memberReference(table, table.userId),
  ],
)

export const workspaceSso = table('workspace_sso', {
  workspaceId: text()
    .primaryKey()
    .references(() => workspaces.workspaceId),
  preset: text().$type<'google' | 'microsoft' | 'oidc'>().notNull(),
  issuer: text().notNull(),
  clientId: text().notNull(),
  encryptedClientSecret: text().notNull(),
  usesInstanceApp: boolean().notNull().default(false),
  updatedAt: instant().notNull(),
})

export const githubApps = table('github_apps', {
  workspaceId: text()
    .primaryKey()
    .references(() => workspaces.workspaceId),
  appId: text().notNull(),
  clientId: text().notNull(),
  encryptedClientSecret: text().notNull(),
  encryptedPrivateKey: text().notNull(),
  encryptedWebhookSecret: text().notNull(),
  updatedAt: instant().notNull(),
})

export const githubWebhookDeliveries = table(
  'github_webhook_deliveries',
  {
    workspaceId: text()
      .notNull()
      .references(() => githubApps.workspaceId, { onDelete: 'cascade' }),
    deliveryId: text().notNull(),
    receivedAt: instant().notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.deliveryId] })],
)

export const ssoDomains = table(
  'sso_domains',
  {
    workspaceId: text()
      .notNull()
      .references(() => workspaceSso.workspaceId, { onDelete: 'cascade' }),
    domain: text().notNull(),
    verifiedAt: instant(),
    verificationEmail: text(),
    verificationTokenHash: text(),
    verificationExpiresAt: instant(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.domain] }),
    index('sso_domains_domain_index').on(table.domain),
    uniqueIndex('sso_domains_verification_token_hash_index').on(table.verificationTokenHash),
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
    harness: text().$type<HarnessId>(),
    localSession: boolean().default(false),
    gitBranch: text(),
    repository: text(),
    baseBranch: text(),
    originChatId: text(),
    agentTurnMessageId: text(),
    agentTurnPrompterId: text(),
    agentTurnFailure: text(),
    contextTokens: integer(),
    contextWindow: integer(),
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
    index().on(table.workspaceId, table.ownerUserId),
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
    uniqueIndex('chat_roles_name_index').on(table.workspaceId, sql`lower(${table.name})`),
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
    index().on(table.workspaceId, table.userId),
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
    ...actorColumns,
    payload: jsonb().notNull(),
    createdAt: instant().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    unique().on(table.chatId, table.seq),
    chatReference(table),
    knownActorKind('events_actor_kind', table.actorKind),
    index('events_audit_index')
      .on(table.workspaceId, table.createdAt)
      .where(sql`${table.type} in (${sql.raw(auditedChatEventTypes.map((type) => `'${type}'`).join(', '))})`),
    index('events_pull_request_index')
      .on(table.workspaceId, table.createdAt)
      .where(
        sql`${table.type} in ('message.posted', 'message.step_changed') and (${table.payload} -> 'step' ->> 'type') = 'pull_request'`,
      ),
    index('events_session_index')
      .on(table.workspaceId, table.chatId, table.seq)
      .where(
        sql`${table.type} = 'agent.event' and ((${table.payload} -> 'event' -> 'update' ->> 'sessionUpdate') in ('session_started', 'config_option_update') or (${table.payload} -> 'event' ->> 'key') = 'agent_state')`,
      ),
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
    attachments: jsonb().$type<readonly MessageAttachment[]>().notNull().default([]),
    step: jsonb().$type<MessageStep>(),
    replyToId: text(),
    threadRootId: text(),
    quotedMessageId: text(),
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
    tenantReference([table.workspaceId, table.quotedMessageId], [table.workspaceId, table.id]),
    index().on(table.workspaceId, table.replyToId),
    index().on(table.workspaceId, table.threadRootId),
    index().on(table.workspaceId, table.quotedMessageId),
    index().on(table.workspaceId, table.chatId, table.seq.asc().nullsFirst()),
    index('messages_pull_request_index')
      .on(table.workspaceId, sql`(${table.step} ->> 'repository')`, sql`(${table.step} ->> 'number')`)
      .where(sql`(${table.step} ->> 'type') = 'pull_request'`),
  ],
)

export const deletedMessageTexts = table(
  'deleted_message_texts',
  {
    ...chatScoped,
    messageId: text().notNull(),
    body: text().notNull(),
    deletedBy: text().notNull(),
    deletedAt: instant().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.messageId] }),
    chatReference(table),
    memberReference(table, table.deletedBy),
    index().on(table.workspaceId, table.deletedAt),
  ],
)

export const messageAttachments = table(
  'message_attachments',
  {
    ...chatScoped,
    id: text().notNull(),
    uploaderId: text().notNull(),
    messageId: text(),
    name: text().notNull(),
    mediaType: text().notNull(),
    size: integer().notNull(),
    content: bytea().notNull(),
    createdAt: instant().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    chatReference(table),
    memberReference(table, table.uploaderId),
    tenantReference([table.workspaceId, table.messageId], [messages.workspaceId, messages.id]),
    index().on(table.workspaceId, table.messageId),
    index().on(table.workspaceId, table.uploaderId, table.createdAt).where(sql`${table.messageId} is null`),
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

export const workspaceOnboarding = table(
  'workspace_onboarding',
  {
    workspaceId: text()
      .notNull()
      .references(() => workspaces.workspaceId),
    task: text().notNull(),
    completedAt: instant().notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.task] })],
)

export const memberOnboarding = table(
  'member_onboarding',
  { ...tenant, userId: text().notNull(), task: text().notNull(), completedAt: instant(), skippedAt: instant() },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId, table.task] }),
    memberReference(table, table.userId),
  ],
)

export type ConnectionTool = { name: string; readOnly: boolean }

export const workspaceConnections = table(
  'workspace_connections',
  {
    workspaceId: text()
      .notNull()
      .references(() => workspaces.workspaceId),
    id: text().notNull(),
    name: text().notNull(),
    gatewayName: text().notNull().unique(),
    url: text().notNull(),
    headerName: text(),
    tools: jsonb().$type<ConnectionTool[]>().notNull(),
    allowedTools: jsonb().$type<string[]>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.id] })],
)

export const connectionRestrictions = table(
  'connection_restrictions',
  {
    ...tenant,
    connectionId: text().notNull(),
    userId: text().notNull(),
    allowedTools: jsonb().$type<string[]>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.connectionId, table.userId] }),
    tenantReference(
      [table.workspaceId, table.connectionId],
      [workspaceConnections.workspaceId, workspaceConnections.id],
    ).onDelete('cascade'),
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

export const githubConnections = table(
  'github_connections',
  {
    ...tenant,
    userId: text().notNull(),
    login: text().notNull(),
    encryptedAccessToken: text().notNull(),
    encryptedRefreshToken: text(),
    accessExpiresAt: instant(),
    needsReconnection: boolean().notNull().default(false),
    updatedAt: instant().notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.userId] }), memberReference(table, table.userId)],
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
    claimedAt: instant(),
    finishedAt: instant(),
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

export const machineCounts = table(
  'machine_counts',
  {
    ...tenant,
    machines: integer().notNull(),
    claudeCode: integer().notNull(),
    codex: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId] }),
    foreignKey({ columns: [table.workspaceId], foreignColumns: [workspaces.workspaceId] }),
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
    llmTokenHash: text(),
    agentConversationId: text(),
    workspaceSnapshot: text(),
    lastActiveAt: instant().notNull(),
    createdAt: instant().notNull(),
    stateChangedAt: instant().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    unique().on(table.workspaceId, table.chatId),
    chatReference(table),
    tenantReference([table.workspaceId, table.hostId], [runtimeHosts.workspaceId, runtimeHosts.id]),
    index().on(table.workspaceId, table.hostId),
    index().on(table.workspaceId, table.state, table.lastActiveAt),
  ],
)

export const browserPages = table(
  'browser_pages',
  { ...chatScoped, url: text().notNull(), title: text().notNull(), openedAt: instant().notNull() },
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
    model: text().notNull(),
    tokens: integer().notNull(),
    costMicros: bigint({ mode: 'number' }).notNull(),
    calls: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.month, table.chatId, table.userId, table.model] }),
    chatReference(table),
    memberReference(table, table.userId),
  ],
)

export const budgets = table(
  'budgets',
  { ...tenant, memberId: text(), limitMicros: bigint({ mode: 'number' }).notNull() },
  (table) => [
    unique('budgets_scope_key').on(table.workspaceId, table.memberId).nullsNotDistinct(),
    check('budgets_limit_micros', sql`${table.limitMicros} > 0`),
    foreignKey({ columns: [table.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    memberReference(table, table.memberId),
  ],
)

export const budgetAlerts = table(
  'budget_alerts',
  {
    ...tenant,
    id: text().notNull(),
    memberId: text(),
    month: text().notNull(),
    threshold: integer().notNull(),
    reachedAt: instant().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    check('budget_alerts_threshold', sql`${table.threshold} in (80, 100)`),
    foreignKey({ columns: [table.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    memberReference(table, table.memberId),
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
    cacheReadTokens: integer().notNull().default(0),
    cacheWriteTokens: integer().notNull().default(0),
    costMicros: integer().notNull(),
    status: text().$type<'success' | 'error'>().notNull(),
    role: text(),
    turnId: text(),
    sessionId: text(),
    calledAt: instant().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    index('model_calls_prompter_index').on(table.workspaceId, table.prompterId, table.calledAt),
    index('model_calls_chat_index').on(table.workspaceId, table.chatId, table.calledAt),
  ],
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
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    chatReference(table),
    index('tool_calls_called_at_index').on(table.workspaceId, table.calledAt),
    index('tool_calls_prompter_index').on(table.workspaceId, table.prompterId, table.calledAt),
  ],
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
    index().on(table.workspaceId, table.chatId, table.promptId).where(sql`${table.status} = 'running'`),
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
    workspaceRoles,
    workspaceRolePermissions,
    memberships,
    invitations,
    projects,
    chats,
    chatRoles,
    chatParticipants,
    messages,
    readMarkers,
    threadReadMarkers,
    runtimeOrigins,
    workspaceConnections,
    connectionRestrictions,
    toolConnections,
    browserPages,
    sources,
    usageEntries,
    budgetAlerts,
    runtimeHosts,
    machineCounts,
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
      memberships: {
        workspaceRole: r.one.workspaceRoles({
          from: [r.memberships.workspaceId, r.memberships.role],
          to: [r.workspaceRoles.workspaceId, r.workspaceRoles.id],
        }),
      },
      workspaceRoles: {
        permissions: r.many.workspaceRolePermissions({
          from: [r.workspaceRoles.workspaceId, r.workspaceRoles.id],
          to: [r.workspaceRolePermissions.workspaceId, r.workspaceRolePermissions.roleId],
        }),
      },
      invitations: {
        memberships: r.many.memberships({ from: r.invitations.workspaceId, to: r.memberships.workspaceId }),
      },
      runtimeHosts: {
        memberships: r.many.memberships({ from: r.runtimeHosts.workspaceId, to: r.memberships.workspaceId }),
      },
      budgetAlerts: {
        memberships: r.many.memberships({ from: r.budgetAlerts.workspaceId, to: r.memberships.workspaceId }),
      },
      machineCounts: {
        memberships: r.many.memberships({ from: r.machineCounts.workspaceId, to: r.memberships.workspaceId }),
      },
      connectionRestrictions: {
        ownedChats: r.many.chats({
          from: [r.connectionRestrictions.workspaceId, r.connectionRestrictions.userId],
          to: [r.chats.workspaceId, r.chats.ownerUserId],
        }),
        memberships: r.many.memberships({
          from: r.connectionRestrictions.workspaceId,
          to: r.memberships.workspaceId,
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
        messages: r.many.messages({
          from: [r.chats.workspaceId, r.chats.id],
          to: [r.messages.workspaceId, r.messages.chatId],
        }),
      },
      chatParticipants: {
        chat: chatOf(r.chatParticipants),
        role: r.one.chatRoles({
          from: [r.chatParticipants.workspaceId, r.chatParticipants.roleId],
          to: [r.chatRoles.workspaceId, r.chatRoles.id],
        }),
      },
      messages: {
        chat: chatOf(r.messages),
        replies: r.many.messages({
          from: [r.messages.workspaceId, r.messages.id],
          to: [r.messages.workspaceId, r.messages.replyToId],
        }),
        threadReplies: r.many.messages({
          from: [r.messages.workspaceId, r.messages.id],
          to: [r.messages.workspaceId, r.messages.threadRootId],
        }),
      },
      readMarkers: { chat: chatOf(r.readMarkers) },
      threadReadMarkers: { chat: chatOf(r.threadReadMarkers) },
      runtimeOrigins: { chat: chatOf(r.runtimeOrigins) },
      browserPages: { chat: chatOf(r.browserPages) },
      sources: { chat: chatOf(r.sources) },
      usageEntries: { chat: chatOf(r.usageEntries) },
      runtimes: { chat: chatOf(r.runtimes) },
    }
  },
)
