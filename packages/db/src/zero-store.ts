import type { MemberId, WorkspaceId } from '@hq/kernel'
import { type Row, Zero } from '@rocicorp/zero'
import { toolCatalog } from './mock-data.ts'
import type { Snapshot } from './schema.ts'
import { createStore, type Store } from './store.ts'
import { type Schema, schema } from './zero.ts'
import { queries, type ZeroContext } from './zero-queries.ts'

type TableName = keyof Schema['tables']
export type ZeroRows = { [Table in TableName]: readonly Row<Schema['tables'][Table]>[] }
export type WorkspaceSession = { token: string; role: ZeroContext['role'] }
export type ZeroStoreOptions = {
  memberId: MemberId
  defaultWorkspaceId: WorkspaceId
  cacheURL: string
  fetchSession: (workspaceId: WorkspaceId) => Promise<WorkspaceSession>
  kvStore?: 'mem' | 'idb'
}

type Unbranded<Value> = Value extends string
  ? string
  : Value extends readonly (infer Item)[]
    ? readonly Unbranded<Item>[]
    : Value extends object
      ? { [Key in keyof Value]: Unbranded<Value[Key]> }
      : Value

const tableNames = Object.keys(schema.tables) as TableName[]

const isoOf = (time: number) => new Date(time).toISOString()
const isoOrNull = (time: number | null) => (time === null ? null : isoOf(time))
const withMemberId = <Row extends { userId: string }>({ userId, ...row }: Row) => ({ ...row, memberId: userId })
const withoutPosition = <Row extends { position: number }>({ position, ...row }: Row) => row
const uniqueBy = <Row>(rows: readonly Row[], keyOf: (row: Row) => string) => [
  ...new Map(rows.map((row) => [keyOf(row), row])).values(),
]

export const snapshotFromZeroRows = (viewerId: MemberId, rowsByWorkspace: readonly Partial<ZeroRows>[]) => {
  const rowsOf = <Table extends TableName>(table: Table) =>
    rowsByWorkspace.flatMap((rows) => rows[table] ?? []) as ZeroRows[Table]
  const workspaces = uniqueBy(rowsOf('workspaces'), (workspace) => workspace.workspaceId)
  const memberships = rowsOf('memberships')
  const messages = rowsOf('messages')
  const runtimeChatIds = new Set(rowsOf('chats').flatMap((chat) => (chat.type === 'runtime' ? [chat.id] : [])))
  const answeredMessageIds = new Set(messages.map((message) => message.replyToId))
  const messageIdBySeq = new Map(messages.map((message) => [`${message.chatId}/${message.seq}`, message.id]))
  const snapshot: Unbranded<Snapshot> = {
    workspaces: workspaces.map(({ workspaceId, name }) => ({ id: workspaceId, name })),
    members: uniqueBy(memberships, (membership) => membership.userId).map(({ userId, displayName }) => ({
      id: userId,
      name: displayName,
    })),
    memberships: uniqueBy(
      [...memberships, ...workspaces.map(({ workspaceId }) => ({ workspaceId, userId: viewerId }))],
      (membership) => `${membership.workspaceId}/${membership.userId}`,
    ).map(({ workspaceId, userId }) => ({ workspaceId, memberId: userId })),
    projects: rowsOf('projects'),
    chats: rowsOf('chats').map(({ ownerKind, ownerUserId, ownerServiceIdentityId, mode, ...chat }) => ({
      ...chat,
      ownerId: ownerUserId ?? '',
    })),
    messages: messages.map(({ seq, replyToId, createdAt, editedAt, deletedAt, ...message }) => ({
      ...message,
      createdAt: isoOf(createdAt),
      editedAt: isoOrNull(editedAt),
      deletedAt: isoOrNull(deletedAt),
      needsReply:
        runtimeChatIds.has(message.chatId) && message.kind === 'member' && !answeredMessageIds.has(message.id),
    })),
    drafts: [],
    readMarkers: rowsOf('readMarkers').map(({ lastReadSeq, ...marker }) => ({
      ...withMemberId(marker),
      lastReadMessageId: messageIdBySeq.get(`${marker.chatId}/${lastReadSeq}`) ?? '',
    })),
    files: rowsOf('files'),
    changes: rowsOf('changes'),
    terminalLines: rowsOf('terminalLines').map(withoutPosition),
    planSteps: rowsOf('planSteps').map(withoutPosition),
    commits: rowsOf('commits').map(({ committedAt, ...commit }) => ({ ...commit, committedAt: isoOf(committedAt) })),
    browserPages: rowsOf('browserPages'),
    usageEntries: rowsOf('usageEntries').map(withMemberId),
    sources: rowsOf('sources'),
    toolConnections: rowsOf('toolConnections').map((connection) => withoutPosition(withMemberId(connection))),
    chatMembers: rowsOf('chatParticipants').map(withMemberId),
    llmCredentials: rowsOf('llmCredentials').map(withMemberId),
    workspaceConnections: rowsOf('workspaceConnections').map((connection) => withoutPosition(withMemberId(connection))),
    toolCatalog,
  }
  return snapshot as Snapshot
}

const writesUnavailable: Store['write'] = () => {
  throw new Error('Writes through Zero are not available until stage 0.4')
}

export const createZeroStore = ({
  memberId,
  defaultWorkspaceId,
  cacheURL,
  fetchSession,
  kvStore,
}: ZeroStoreOptions) => {
  const store = createStore(snapshotFromZeroRows(memberId, []))
  const rowsByWorkspace = new Map<WorkspaceId, Partial<ZeroRows>>()
  const zeroByWorkspace = new Map<WorkspaceId, Promise<Zero | undefined>>()
  const loadedByWorkspace = new Map<WorkspaceId, PromiseWithResolvers<void>>()
  const signedOutWorkspaceIds = new Set<WorkspaceId>()
  let isClosed = false
  let isPublishScheduled = false
  const publish = () => {
    if (isPublishScheduled) return
    isPublishScheduled = true
    queueMicrotask(() => {
      isPublishScheduled = false
      store.write(() => snapshotFromZeroRows(memberId, [...rowsByWorkspace.values()]))
    })
  }
  const loadedOf = (workspaceId: WorkspaceId) => {
    const loaded = loadedByWorkspace.get(workspaceId) ?? Promise.withResolvers<void>()
    loadedByWorkspace.set(workspaceId, loaded)
    return loaded
  }
  const connect = (workspaceId: WorkspaceId, { token, role }: WorkspaceSession) => {
    const zero = new Zero({
      cacheURL,
      schema,
      userID: memberId,
      auth: token,
      context: { userId: memberId, workspaceId, role },
      storageKey: workspaceId,
      kvStore,
    })
    const rows: Partial<ZeroRows> = {}
    const completeTables = new Set<TableName>()
    rowsByWorkspace.set(workspaceId, rows)
    for (const table of tableNames)
      zero
        .materialize((queries[table] as () => Parameters<typeof zero.materialize>[0])())
        .addListener((data, result) => {
          if (rowsByWorkspace.get(workspaceId) !== rows) return
          rows[table] = (data as readonly object[]).map((row) => Object.fromEntries(Object.entries(row))) as never
          publish()
          if (table === 'workspaces')
            for (const workspace of data as ZeroRows['workspaces']) open(workspace.workspaceId as WorkspaceId)
          if (result === 'complete') completeTables.add(table)
          if (completeTables.size === tableNames.length) loadedOf(workspaceId).resolve()
        })
    return zero
  }
  const open = (workspaceId: WorkspaceId) => {
    if (isClosed || zeroByWorkspace.has(workspaceId) || signedOutWorkspaceIds.has(workspaceId)) return
    const opening: Promise<Zero | undefined> = fetchSession(workspaceId).then(
      (session) => (zeroByWorkspace.get(workspaceId) === opening ? connect(workspaceId, session) : undefined),
      (error) => {
        zeroByWorkspace.delete(workspaceId)
        console.error(error)
        return undefined
      },
    )
    zeroByWorkspace.set(workspaceId, opening)
  }
  const close = async (workspaceId: WorkspaceId) => {
    const zero = zeroByWorkspace.get(workspaceId)
    zeroByWorkspace.delete(workspaceId)
    loadedByWorkspace.delete(workspaceId)
    rowsByWorkspace.set(workspaceId, { workspaces: rowsByWorkspace.get(workspaceId)?.workspaces ?? [] })
    publish()
    return zero
  }
  open(defaultWorkspaceId)
  return {
    read: store.read,
    subscribe: store.subscribe,
    write: writesUnavailable,
    whenLoaded: (workspaceId: WorkspaceId) => loadedOf(workspaceId).promise,
    signOut: async (workspaceId: WorkspaceId) => {
      signedOutWorkspaceIds.add(workspaceId)
      await (await close(workspaceId))?.delete()
    },
    signIn: (workspaceId: WorkspaceId) => {
      signedOutWorkspaceIds.delete(workspaceId)
      open(workspaceId)
    },
    close: () => {
      isClosed = true
      return Promise.all([...zeroByWorkspace.keys()].map(async (workspaceId) => (await close(workspaceId))?.close()))
    },
  }
}
