import { type AnyMutatorRegistry, type MutatorResultDetails, type Row, Zero } from '@rocicorp/zero'
import { domainErrorOf, type MemberId, type WorkspaceId, workspacePermissions } from '@spyria/kernel'
import type { DraftRow, MessageRow, Snapshot } from './schema.ts'
import { type Schema, schema } from './zero.ts'
import { queries } from './zero-queries.ts'

type TableName = keyof Schema['tables']
type ZeroRows = { [Table in TableName]: readonly Row<Schema['tables'][Table]>[] }
type SourceRows = Partial<Record<string, readonly object[]>>
export const scopedQueryNames = [
  'chatMessages',
  'chatPinnedSteps',
  'chatBrowserPages',
  'chatUsage',
  'monthUsage',
  'searchMessages',
] as const
export type ScopedQueryName = (typeof scopedQueryNames)[number]
export type ScopedStatus = { isComplete: boolean; rows: readonly object[] }
type ScopedWatch = {
  workspaceId: WorkspaceId
  name: ScopedQueryName
  args: Record<string, string | number>
  count: number
  view?: { destroy: () => void }
  status?: ScopedStatus
}
export type WorkspaceSession = { workspaceId: WorkspaceId; token: string; expiresAt: number }
type ZeroStoreOptions = {
  memberId: MemberId
  sessions: readonly WorkspaceSession[]
  renew: (workspaceId: WorkspaceId) => Promise<WorkspaceSession | undefined>
  cacheURL: string
  kvStore?: 'mem' | 'idb'
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
  storageKeyPrefix?: string
  mutators?: AnyMutatorRegistry
  draftStorage?: Storage
  syncedTablesStorage?: Storage
}

type Unbranded<Value> = Value extends string
  ? string
  : Value extends readonly (infer Item)[]
    ? readonly Unbranded<Item>[]
    : Value extends object
      ? { [Key in keyof Value]: Unbranded<Value[Key]> }
      : Value

const unmaterializedQueries = ['~', 'serviceIdentities', ...scopedQueryNames] as const
const materializedTables = Object.keys(queries).filter(
  (table) => !unmaterializedQueries.includes(table as never),
) as Exclude<keyof typeof queries, (typeof unmaterializedQueries)[number]>[]

const isoOf = (time: number) => new Date(time).toISOString()
const isoOrNull = (time: number | null) => (time === null ? null : isoOf(time))
const withMemberId = <Row extends { userId: string }>({ userId, ...row }: Row) => ({ ...row, memberId: userId })
const withoutPosition = <Row extends { position: number }>({ position, ...row }: Row) => row
const withoutCreatedAt = <Row extends { createdAt: number }>({ createdAt, ...row }: Row) => row
const uniqueBy = <Row>(rows: readonly Row[], keyOf: (row: Row) => string) => [
  ...new Map(rows.map((row) => [keyOf(row), row])).values(),
]
const withoutZeroRefCount = <Row extends object>(row: Row) => Object.fromEntries(Object.entries(row)) as Row
const isWorkspaceRowIn = (rows: unknown, workspaceId: WorkspaceId) =>
  (rows as readonly { workspaceId: string }[]).some((row) => row.workspaceId === workspaceId)
const isSameSources = (previous: readonly unknown[], next: readonly unknown[]) =>
  previous.length === next.length && previous.every((source, index) => source === next[index])
const scopedKeyOf = (workspaceId: WorkspaceId, name: ScopedQueryName, args: object) =>
  `${workspaceId}/${name}/${JSON.stringify(args)}`
const chatsWithLatestMessage = ['latestMessages', 'latestAgentActivity']
const latestMessagesIn = (chats: readonly object[]) =>
  chats.flatMap((chat) => (chat as { messages: readonly object[] }).messages)
type WindowRoot = { id: string; replies: readonly object[]; threadReplies: readonly object[] }
const messageWithoutRepliesByRow = new WeakMap<object, object>()
const withoutReplies = (row: object) => {
  const cached = messageWithoutRepliesByRow.get(row)
  if (cached) return cached
  const { replies, threadReplies, ...message } = row as WindowRoot
  messageWithoutRepliesByRow.set(row, message)
  return message
}
export const windowMessagesIn = (roots: readonly object[]) =>
  uniqueBy(
    (roots as readonly WindowRoot[]).flatMap((root) => [withoutReplies(root), ...root.replies, ...root.threadReplies]),
    (message) => (message as { id: string }).id,
  )
const memoizedOnSources = <Sources extends readonly unknown[], Value>(build: (...sources: Sources) => Value) => {
  let previous: { sources: Sources; value: Value } | undefined
  return (...sources: Sources) => {
    if (previous && isSameSources(previous.sources, sources)) return previous.value
    previous = { sources, value: build(...sources) }
    return previous.value
  }
}
const mappedRows = <ZeroRow extends object, SnapshotRow>(map: (row: ZeroRow) => SnapshotRow) => {
  const snapshotRowByZeroRow = new WeakMap<ZeroRow, SnapshotRow>()
  const snapshotRowOf = (row: ZeroRow) => {
    const cached = snapshotRowByZeroRow.get(row)
    if (cached) return cached
    const mapped = map(withoutZeroRefCount(row))
    snapshotRowByZeroRow.set(row, mapped)
    return mapped
  }
  return memoizedOnSources((rows: readonly ZeroRow[]) => rows.map(snapshotRowOf))
}
const emptyRows: readonly never[] = []
const renewalLeadMilliseconds = 60_000
const renewalRetryMilliseconds = 5_000

export const createSnapshotBuilder = (viewerId: MemberId) => {
  const concatenatedRowsBySource = new Map<string, (...rows: readonly (readonly object[])[]) => readonly object[]>()
  const messageRowByZeroRow = new WeakMap<ZeroRows['messages'][number], Unbranded<MessageRow>>()
  const messageRowOf = (row: ZeroRows['messages'][number], needsReply: boolean) => {
    const cached = messageRowByZeroRow.get(row)
    if (cached?.needsReply === needsReply) return cached
    const { createdAt, editedAt, deletedAt, attachments, ...message } = withoutZeroRefCount(row)
    const mapped = {
      ...message,
      attachments: attachments ?? [],
      createdAt: isoOf(createdAt),
      editedAt: isoOrNull(editedAt),
      deletedAt: isoOrNull(deletedAt),
      needsReply,
    }
    messageRowByZeroRow.set(row, mapped)
    return mapped
  }
  const workspacesOf = memoizedOnSources((workspaces: ZeroRows['workspaces']) =>
    uniqueBy(workspaces, (workspace) => workspace.workspaceId),
  )
  const workspaceRowsOf = memoizedOnSources((workspaces: ZeroRows['workspaces']) =>
    workspaces.map(({ workspaceId, name, localSessions }) => ({
      id: workspaceId,
      name,
      localSessions: localSessions ?? true,
    })),
  )
  const membershipsOf = memoizedOnSources(
    (workspaces: ZeroRows['workspaces'], memberships: ZeroRows['memberships'], users: ZeroRows['users']) => {
      const emailByUserId = new Map(users.map((user) => [user.id, user.email]))
      return uniqueBy(
        [
          ...workspaces.map(({ workspaceId }) => ({
            workspaceId,
            userId: viewerId,
            displayName: '',
            avatar: null,
            role: 'member',
            removedAt: null,
          })),
          ...memberships,
        ],
        (membership) => `${membership.workspaceId}/${membership.userId}`,
      ).map(({ workspaceId, userId, displayName, avatar, role, removedAt }) => ({
        workspaceId,
        memberId: userId,
        displayName,
        avatar: avatar ?? null,
        email: emailByUserId.get(userId) ?? '',
        role,
        removedAt: isoOrNull(removedAt ?? null),
      }))
    },
  )
  const workspaceRolesOf = memoizedOnSources(
    (roles: ZeroRows['workspaceRoles'], rolePermissions: ZeroRows['workspaceRolePermissions']) =>
      roles.map((role) => ({
        ...withoutZeroRefCount(role),
        permissions: workspacePermissions.filter((permission) =>
          rolePermissions.some(
            (granted) =>
              granted.workspaceId === role.workspaceId &&
              granted.roleId === role.id &&
              granted.permission === permission,
          ),
        ),
      })),
  )
  const runtimeChatIdsKeyOf = memoizedOnSources((chats: ZeroRows['chats']) =>
    chats.flatMap((chat) => (chat.type === 'runtime' ? [chat.id] : [])).join('\n'),
  )
  const threadSeqByZeroRow = new WeakMap<ZeroRows['messages'][number], number>()
  const messagesOf = memoizedOnSources((messages: ZeroRows['messages'], runtimeChatIdsKey: string) => {
    const runtimeChatIds = new Set(runtimeChatIdsKey.split('\n'))
    const answeredMessageIds = new Set(messages.map((message) => message.replyToId))
    const newChatIds = new Set<string>()
    for (const message of messages) if (!threadSeqByZeroRow.has(message)) newChatIds.add(message.chatId)
    const seqByMessageKey = new Map<string, number>()
    for (const message of messages)
      if (newChatIds.has(message.chatId)) seqByMessageKey.set(`${message.chatId}/${message.id}`, message.seq)
    const threadSeqs = messages.map((message) => {
      const cached = threadSeqByZeroRow.get(message)
      if (cached !== undefined) return cached
      const parentSeq = seqByMessageKey.get(`${message.chatId}/${message.replyToId}`)
      if (parentSeq !== undefined || message.replyToId === null)
        threadSeqByZeroRow.set(message, parentSeq ?? message.seq)
      return parentSeq ?? message.seq
    })
    return messages
      .map((_, index) => index)
      .sort((first, second) => {
        const firstMessage = messages[first] as ZeroRows['messages'][number]
        const secondMessage = messages[second] as ZeroRows['messages'][number]
        return (
          (firstMessage.chatId === secondMessage.chatId
            ? 0
            : firstMessage.chatId.localeCompare(secondMessage.chatId)) ||
          (threadSeqs[first] as number) - (threadSeqs[second] as number) ||
          firstMessage.seq - secondMessage.seq
        )
      })
      .map((index) => {
        const message = messages[index] as ZeroRows['messages'][number]
        return messageRowOf(
          message,
          runtimeChatIds.has(message.chatId) &&
            message.kind === 'member' &&
            message.replyToId === null &&
            !answeredMessageIds.has(message.id),
        )
      })
  })
  const plainMessagesOf = () =>
    memoizedOnSources((messages: ZeroRows['messages']) => messages.map((message) => messageRowOf(message, false)))
  const latestMessagesOf = plainMessagesOf()
  const latestAgentActivityOf = plainMessagesOf()
  const pinnedStepsOf = plainMessagesOf()
  const usageRowsOf = memoizedOnSources((chatUsage: ZeroRows['usageEntries'], monthUsage: ZeroRows['usageEntries']) =>
    uniqueBy(
      [...chatUsage, ...monthUsage],
      (entry) => `${entry.workspaceId}/${entry.month}/${entry.chatId}/${entry.userId}/${entry.model}`,
    ),
  )
  const invitationsOf = mappedRows(({ workspaceId, id, email, role, expiresAt }: ZeroRows['invitations'][number]) => ({
    workspaceId,
    id,
    email,
    role,
    expiresAt,
  }))
  const projectsOf = mappedRows(withoutCreatedAt<ZeroRows['projects'][number]>)
  const chatsOf = mappedRows(
    ({ ownerKind, ownerUserId, ownerServiceIdentityId, mode, createdAt, ...chat }: ZeroRows['chats'][number]) => ({
      ...chat,
      subagentPolicy: chat.subagentPolicy ?? 'auto',
      harness: chat.harness ?? null,
      localSession: chat.localSession ?? null,
      contextTokens: chat.contextTokens ?? null,
      contextWindow: chat.contextWindow ?? null,
      ownerId: ownerUserId ?? '',
    }),
  )
  const readMarkersOf = mappedRows(withMemberId<ZeroRows['readMarkers'][number]>)
  const threadReadMarkersOf = mappedRows(withMemberId<ZeroRows['threadReadMarkers'][number]>)
  const runtimeOriginsOf = mappedRows((origin: ZeroRows['runtimeOrigins'][number]) => origin)
  const browserPagesOf = mappedRows(({ openedAt, ...page }: ZeroRows['browserPages'][number]) => ({
    ...page,
    openedAt: isoOf(openedAt),
  }))
  const usageEntriesOf = mappedRows(withMemberId<ZeroRows['usageEntries'][number]>)
  const budgetAlertsOf = mappedRows(({ reachedAt, ...alert }: ZeroRows['budgetAlerts'][number]) => alert)
  const sourcesOf = mappedRows((source: ZeroRows['sources'][number]) => source)
  const toolConnectionsOf = mappedRows((connection: ZeroRows['toolConnections'][number]) =>
    withoutPosition(withMemberId(connection)),
  )
  const chatMembersOf = mappedRows(withMemberId<ZeroRows['chatParticipants'][number]>)
  const chatRolesOf = mappedRows((role: ZeroRows['chatRoles'][number]) => role)
  const llmCredentialsOf = mappedRows(withMemberId<ZeroRows['llmCredentials'][number]>)
  const ssoDomainsOf = mappedRows(({ workspaceId, domain, verifiedAt }: ZeroRows['ssoDomains'][number]) => ({
    workspaceId,
    domain,
    isVerified: verifiedAt != null,
  }))
  const githubAppsOf = mappedRows(({ workspaceId }: ZeroRows['githubApps'][number]) => ({ workspaceId }))
  const githubConnectionsOf = mappedRows(({ workspaceId, userId }: ZeroRows['githubConnections'][number]) => ({
    workspaceId,
    memberId: userId,
  }))
  const workspaceOnboardingOf = mappedRows(({ workspaceId, task }: ZeroRows['workspaceOnboarding'][number]) => ({
    workspaceId,
    task,
  }))
  const memberOnboardingOf = mappedRows(
    ({ workspaceId, userId, task, completedAt, skippedAt }: ZeroRows['memberOnboarding'][number]) => ({
      workspaceId,
      memberId: userId,
      task,
      isCompleted: completedAt != null,
      isSkipped: skippedAt != null,
    }),
  )
  const workspaceConnectionsOf = mappedRows((connection: ZeroRows['workspaceConnections'][number]) => connection)
  const connectionRestrictionsOf = mappedRows(withMemberId<ZeroRows['connectionRestrictions'][number]>)
  const runtimeHostsOf = mappedRows(
    ({ lastSeenAt, createdBy, createdAt, removedAt, ...host }: ZeroRows['runtimeHosts'][number]) => host,
  )
  const machineCountsOf = mappedRows((counts: ZeroRows['machineCounts'][number]) => counts)
  const runtimesOf = mappedRows(
    ({ workspaceId, id, chatId, hostId, state, failure, hostOnline }: ZeroRows['runtimes'][number]) => ({
      workspaceId,
      id,
      chatId,
      hostId,
      state,
      failure,
      hostOnline: hostOnline === true,
    }),
  )
  let previous: Snapshot | undefined
  return (rowsByWorkspace: readonly SourceRows[]) => {
    const rowsOf = <Table extends TableName>(table: Table, source: string = table) => {
      const concatenatedRows =
        concatenatedRowsBySource.get(source) ??
        memoizedOnSources((...rows: readonly (readonly object[])[]) => rows.flat())
      concatenatedRowsBySource.set(source, concatenatedRows)
      return concatenatedRows(...rowsByWorkspace.map((rows) => rows[source] ?? emptyRows)) as ZeroRows[Table]
    }
    const workspaces = workspacesOf(rowsOf('workspaces'))
    const snapshot: Unbranded<Snapshot> = {
      workspaces: workspaceRowsOf(workspaces),
      memberships: membershipsOf(workspaces, rowsOf('memberships'), rowsOf('users')),
      workspaceRoles: workspaceRolesOf(rowsOf('workspaceRoles'), rowsOf('workspaceRolePermissions')),
      invitations: invitationsOf(rowsOf('invitations')),
      projects: projectsOf(rowsOf('projects')),
      chats: chatsOf(rowsOf('chats')),
      messages: messagesOf(rowsOf('messages', 'chatMessages'), runtimeChatIdsKeyOf(rowsOf('chats'))),
      latestMessages: latestMessagesOf(rowsOf('messages', 'latestMessages')),
      latestAgentActivity: latestAgentActivityOf(rowsOf('messages', 'latestAgentActivity')),
      pinnedSteps: pinnedStepsOf(rowsOf('messages', 'chatPinnedSteps')),
      readMarkers: readMarkersOf(rowsOf('readMarkers')),
      threadReadMarkers: threadReadMarkersOf(rowsOf('threadReadMarkers')),
      runtimeOrigins: runtimeOriginsOf(rowsOf('runtimeOrigins')),
      browserPages: browserPagesOf(rowsOf('browserPages', 'chatBrowserPages')),
      usageEntries: usageEntriesOf(
        usageRowsOf(rowsOf('usageEntries', 'chatUsage'), rowsOf('usageEntries', 'monthUsage')),
      ),
      budgetAlerts: budgetAlertsOf(rowsOf('budgetAlerts')),
      sources: sourcesOf(rowsOf('sources')),
      toolConnections: toolConnectionsOf(rowsOf('toolConnections')),
      chatMembers: chatMembersOf(rowsOf('chatParticipants')),
      chatRoles: chatRolesOf(rowsOf('chatRoles')),
      llmCredentials: llmCredentialsOf(rowsOf('llmCredentials')),
      ssoDomains: ssoDomainsOf(rowsOf('ssoDomains')),
      githubApps: githubAppsOf(rowsOf('githubApps')),
      githubConnections: githubConnectionsOf(rowsOf('githubConnections')),
      workspaceOnboarding: workspaceOnboardingOf(rowsOf('workspaceOnboarding')),
      memberOnboarding: memberOnboardingOf(rowsOf('memberOnboarding')),
      workspaceConnections: workspaceConnectionsOf(rowsOf('workspaceConnections')),
      connectionRestrictions: connectionRestrictionsOf(rowsOf('connectionRestrictions')),
      runtimeHosts: runtimeHostsOf(rowsOf('runtimeHosts')),
      machineCounts: machineCountsOf(rowsOf('machineCounts')),
      runtimes: runtimesOf(rowsOf('runtimes')),
    }
    if (previous && isSameSources(Object.values(previous), Object.values(snapshot))) return previous
    previous = snapshot as Snapshot
    return previous
  }
}

export type Store = ReturnType<typeof createZeroStore>

const failureOf = (details: MutatorResultDetails) => {
  if (details.type !== 'error') return undefined
  const domainCode =
    details.error.type === 'app' ? (details.error.details as { code?: unknown } | null | undefined)?.code : undefined
  return typeof domainCode === 'string'
    ? domainErrorOf(domainCode, details.error.message)
    : new Error(details.error.message)
}

export const createZeroStore = ({
  memberId,
  sessions,
  renew,
  cacheURL,
  kvStore,
  logLevel,
  storageKeyPrefix = '',
  mutators,
  draftStorage,
  syncedTablesStorage,
}: ZeroStoreOptions) => {
  const draftKeyPrefix = `spyria.draft:${memberId}:`
  const draftKeyOf = (draft: DraftRow) => `${draftKeyPrefix}${draft.workspaceId}:${draft.chatId}`
  const syncedTablesKeyOf = (workspaceId: WorkspaceId) =>
    `spyria.synced-tables:${memberId}:${storageKeyPrefix}${workspaceId}`
  const isEveryTableCached = (workspaceId: WorkspaceId) => {
    const syncedTables: readonly string[] = JSON.parse(
      syncedTablesStorage?.getItem(syncedTablesKeyOf(workspaceId)) ?? '[]',
    )
    return materializedTables.every((table) => syncedTables.includes(table))
  }
  let drafts: readonly DraftRow[] = Array.from({ length: draftStorage?.length ?? 0 }, (_, index) =>
    draftStorage?.key(index),
  ).flatMap((key) => (key?.startsWith(draftKeyPrefix) ? [JSON.parse(draftStorage?.getItem(key) ?? '{}')] : []))
  const snapshotOf = createSnapshotBuilder(memberId)
  let snapshot = snapshotOf([])
  const listeners = new Set<() => void>()
  const draftListeners = new Set<() => void>()
  const renewalListeners = new Set<(workspaceId: WorkspaceId) => void>()
  const rowsByWorkspace = new Map<WorkspaceId, SourceRows>()
  const scopedWatches = new Map<string, ScopedWatch>()
  const zeroByWorkspace = new Map<WorkspaceId, Zero>()
  const tokenByWorkspace = new Map<WorkspaceId, string>()
  const loadedByWorkspace = new Map<WorkspaceId, PromiseWithResolvers<void>>()
  const readableByWorkspace = new Map<WorkspaceId, PromiseWithResolvers<void>>()
  const completeTablesByWorkspace = new Map<WorkspaceId, ReadonlySet<string>>()
  const expiresAtByWorkspace = new Map<WorkspaceId, number>()
  const clientIdsByWorkspace = new Map<WorkspaceId, { clientID: string; clientGroupID?: string }>()
  const connectionEvents: { at: string; workspaceId: WorkspaceId; event: string }[] = []
  const noteConnection = (workspaceId: WorkspaceId, event: string) => {
    connectionEvents.push({ at: new Date().toISOString(), workspaceId, event })
    if (connectionEvents.length > 200) connectionEvents.shift()
  }
  const renewalTimerByWorkspace = new Map<WorkspaceId, ReturnType<typeof setTimeout>>()
  let signedInWorkspaceIds: ReadonlySet<WorkspaceId> = new Set(sessions.map((session) => session.workspaceId))
  let isPublishScheduled = false
  const publish = () => {
    if (isPublishScheduled) return
    isPublishScheduled = true
    queueMicrotask(() => {
      isPublishScheduled = false
      snapshot = snapshotOf([...rowsByWorkspace.values()])
      for (const listener of listeners) listener()
    })
  }
  const feedScoped = (workspaceId: WorkspaceId, name: ScopedQueryName) => {
    const rows = rowsByWorkspace.get(workspaceId)
    if (!rows) return
    const fed = [...scopedWatches.values()].filter(
      (watch) => watch.workspaceId === workspaceId && watch.name === name && watch.status,
    )
    const fedRows = fed.length === 1 ? fed[0]?.status?.rows : fed.flatMap((watch) => watch.status?.rows ?? [])
    rows[name] = name === 'chatMessages' && fedRows ? windowMessagesIn(fedRows) : fedRows
    publish()
  }
  const materializeScoped = (watch: ScopedWatch) => {
    const zero = zeroByWorkspace.get(watch.workspaceId)
    if (!zero || watch.view) return
    const request = (queries[watch.name] as unknown as (args: object) => Parameters<Zero['materialize']>[0])(watch.args)
    const view = zero.materialize(request)
    watch.view = view
    view.addListener((data, result) => {
      if (watch.view !== view) return
      watch.status = { isComplete: result === 'complete', rows: data as readonly object[] }
      feedScoped(watch.workspaceId, watch.name)
    })
  }
  const resolverIn = (resolvers: Map<WorkspaceId, PromiseWithResolvers<void>>, workspaceId: WorkspaceId) => {
    const resolver = resolvers.get(workspaceId) ?? Promise.withResolvers<void>()
    resolvers.set(workspaceId, resolver)
    return resolver
  }
  const loadedOf = (workspaceId: WorkspaceId) => resolverIn(loadedByWorkspace, workspaceId)
  const readableOf = (workspaceId: WorkspaceId) => resolverIn(readableByWorkspace, workspaceId)
  const isLoaded = (workspaceId: WorkspaceId) =>
    completeTablesByWorkspace.get(workspaceId)?.size === materializedTables.length
  const renewLater = (workspaceId: WorkspaceId, delayMilliseconds: number) => {
    clearTimeout(renewalTimerByWorkspace.get(workspaceId))
    renewalTimerByWorkspace.set(workspaceId, setTimeout(renewNow, delayMilliseconds, workspaceId))
  }
  const scheduleRenewal = ({ workspaceId, expiresAt }: WorkspaceSession) => {
    const remainingMilliseconds = expiresAt - Date.now()
    renewLater(workspaceId, Math.max(remainingMilliseconds - renewalLeadMilliseconds, remainingMilliseconds / 2))
  }
  const renewNow = async (workspaceId: WorkspaceId) => {
    const zero = zeroByWorkspace.get(workspaceId)
    const renewed = await renew(workspaceId).catch(() => null)
    if (!zero || zeroByWorkspace.get(workspaceId) !== zero) return
    noteConnection(workspaceId, renewed === null ? 'renew failed' : renewed === undefined ? 'renew refused' : 'renewed')
    if (renewed === null) return renewLater(workspaceId, renewalRetryMilliseconds)
    if (renewed === undefined) return signOut(workspaceId)
    scheduleRenewal(renewed)
    expiresAtByWorkspace.set(workspaceId, renewed.expiresAt)
    tokenByWorkspace.set(workspaceId, renewed.token)
    for (const listener of renewalListeners) listener(workspaceId)
    await zero.connection.connect({ auth: renewed.token })
  }
  const connect = (session: WorkspaceSession) => {
    const { workspaceId, token } = session
    const zero = new Zero({
      cacheURL,
      schema,
      userID: memberId,
      auth: token,
      context: { userId: memberId, workspaceId },
      storageKey: `${storageKeyPrefix}${workspaceId}`,
      kvStore,
      logLevel,
      mutators,
    })
    const clientIds = { clientID: zero.clientID, clientGroupID: undefined as string | undefined }
    clientIdsByWorkspace.set(workspaceId, clientIds)
    zero.clientGroupID.then((clientGroupID) => {
      clientIds.clientGroupID = clientGroupID
    })
    const rows: SourceRows = {}
    const completeTables = new Set<string>()
    completeTablesByWorkspace.set(workspaceId, completeTables)
    rowsByWorkspace.set(workspaceId, rows)
    zeroByWorkspace.set(workspaceId, zero)
    tokenByWorkspace.set(workspaceId, token)
    expiresAtByWorkspace.set(workspaceId, session.expiresAt)
    const isCacheReadable = isEveryTableCached(workspaceId)
    for (const table of materializedTables)
      zero
        .materialize((queries[table] as () => Parameters<typeof zero.materialize>[0])())
        .addListener((data, result) => {
          if (rowsByWorkspace.get(workspaceId) !== rows) return
          rows[table] = chatsWithLatestMessage.includes(table)
            ? latestMessagesIn(data as readonly object[])
            : (data as object[])
          publish()
          if (isCacheReadable && table === 'workspaces' && isWorkspaceRowIn(data, workspaceId))
            readableOf(workspaceId).resolve()
          if (result !== 'complete' || completeTables.has(table)) return
          completeTables.add(table)
          if (!isLoaded(workspaceId)) return
          syncedTablesStorage?.setItem(syncedTablesKeyOf(workspaceId), JSON.stringify(materializedTables))
          readableOf(workspaceId).resolve()
          loadedOf(workspaceId).resolve()
        })
    for (const watch of scopedWatches.values()) if (watch.workspaceId === workspaceId) materializeScoped(watch)
    zero.connection.state.subscribe((state) => {
      noteConnection(workspaceId, 'reason' in state ? `${state.name} ${JSON.stringify(state.reason)}` : state.name)
      if (state.name === 'needs-auth') renewNow(workspaceId)
    })
    scheduleRenewal(session)
  }
  const close = (workspaceId: WorkspaceId) => {
    const zero = zeroByWorkspace.get(workspaceId)
    noteConnection(workspaceId, 'closed by the store')
    clearTimeout(renewalTimerByWorkspace.get(workspaceId))
    for (const watch of scopedWatches.values())
      if (watch.workspaceId === workspaceId) {
        watch.view?.destroy()
        watch.view = undefined
        watch.status = undefined
      }
    zeroByWorkspace.delete(workspaceId)
    loadedByWorkspace.delete(workspaceId)
    readableByWorkspace.delete(workspaceId)
    completeTablesByWorkspace.delete(workspaceId)
    signedInWorkspaceIds = new Set([...signedInWorkspaceIds].filter((signedInId) => signedInId !== workspaceId))
    rowsByWorkspace.set(workspaceId, { workspaces: rowsByWorkspace.get(workspaceId)?.workspaces ?? [] })
    publish()
    return zero
  }
  const markSignedIn = (workspaceId: WorkspaceId) => {
    signedInWorkspaceIds = new Set([...signedInWorkspaceIds, workspaceId])
    publish()
  }
  const signOut = async (workspaceId: WorkspaceId) => {
    syncedTablesStorage?.removeItem(syncedTablesKeyOf(workspaceId))
    await close(workspaceId)?.delete()
  }
  for (const session of sessions) connect(session)
  return {
    read: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    readDrafts: () => drafts,
    subscribeDrafts: (listener: () => void) => {
      draftListeners.add(listener)
      return () => {
        draftListeners.delete(listener)
      }
    },
    replaceDraft: (draft: DraftRow) => {
      const isReplaced = (stored: DraftRow) =>
        stored.workspaceId === draft.workspaceId && stored.chatId === draft.chatId && stored.memberId === draft.memberId
      if ((drafts.find(isReplaced)?.text ?? '') === draft.text) return
      drafts = [...drafts.filter((stored) => !isReplaced(stored)), ...(draft.text === '' ? [] : [draft])]
      if (draft.text === '') draftStorage?.removeItem(draftKeyOf(draft))
      else draftStorage?.setItem(draftKeyOf(draft), JSON.stringify(draft))
      for (const listener of draftListeners) listener()
    },
    whenLoaded: (workspaceId: WorkspaceId) => loadedOf(workspaceId).promise,
    whenReadable: (workspaceId: WorkspaceId) => readableOf(workspaceId).promise,
    isLoaded,
    diagnostics: () => ({
      cacheURL,
      connectionEvents,
      workspaces: Object.fromEntries(
        [...clientIdsByWorkspace].map(([workspaceId, clientIds]) => {
          const completeTables = completeTablesByWorkspace.get(workspaceId)
          return [
            workspaceId,
            {
              ...clientIds,
              pending: completeTables ? materializedTables.filter((table) => !completeTables.has(table)) : [],
              state: zeroByWorkspace.get(workspaceId)?.connection.state.current ?? 'closed',
              tokenExpiresAt: new Date(expiresAtByWorkspace.get(workspaceId) ?? 0).toISOString(),
            },
          ]
        }),
      ),
    }),
    watch: (workspaceId: WorkspaceId, name: ScopedQueryName, args: ScopedWatch['args']) => {
      const key = scopedKeyOf(workspaceId, name, args)
      const watch = scopedWatches.get(key) ?? { workspaceId, name, args, count: 0 }
      scopedWatches.set(key, watch)
      watch.count++
      materializeScoped(watch)
      return () => {
        if (--watch.count > 0) return
        scopedWatches.delete(key)
        watch.view?.destroy()
        watch.view = undefined
        feedScoped(workspaceId, name)
      }
    },
    scopedStatus: (workspaceId: WorkspaceId, name: ScopedQueryName, args: ScopedWatch['args']) =>
      scopedWatches.get(scopedKeyOf(workspaceId, name, args))?.status,
    mutate: async (workspaceId: WorkspaceId, request: Parameters<Zero['mutate']>[0]) => {
      if (signedInWorkspaceIds.has(workspaceId)) await loadedOf(workspaceId).promise
      const zero = zeroByWorkspace.get(workspaceId)
      if (!zero) throw new Error(`Workspace ${workspaceId} is not open`)
      const result = zero.mutate(request)
      const clientFailure = failureOf(await result.client)
      if (clientFailure) throw clientFailure
      const confirmation = result.server.then((details) => {
        const serverFailure = failureOf(details)
        if (serverFailure) throw serverFailure
      })
      confirmation.catch(console.error)
      return { confirmation }
    },
    signedInWorkspaceIds: () => signedInWorkspaceIds,
    renewSession: renewNow,
    onSessionRenewed: (listener: (workspaceId: WorkspaceId) => void) => {
      renewalListeners.add(listener)
      return () => {
        renewalListeners.delete(listener)
      }
    },
    tokenOf: (workspaceId: WorkspaceId) => tokenByWorkspace.get(workspaceId) ?? '',
    signOut,
    signIn: async (session: WorkspaceSession) => {
      if (!zeroByWorkspace.has(session.workspaceId)) connect(session)
      await loadedOf(session.workspaceId).promise
      markSignedIn(session.workspaceId)
    },
    close: () => Promise.all([...zeroByWorkspace.keys()].map((workspaceId) => close(workspaceId)?.close())),
  }
}
