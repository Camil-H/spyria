import type { MemberId, WorkspaceId } from '@hq/kernel'
import { type AnyMutatorRegistry, type MutatorResultDetails, type Row, Zero } from '@rocicorp/zero'
import { toolCatalog } from './mock-data.ts'
import type { DraftRow, Snapshot } from './schema.ts'
import { createStore } from './store.ts'
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
  mutators?: AnyMutatorRegistry
  draftStorage?: Storage
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
const withoutCreatedAt = <Row extends { createdAt: number }>({ createdAt, ...row }: Row) => row
const uniqueBy = <Row>(rows: readonly Row[], keyOf: (row: Row) => string) => [
  ...new Map(rows.map((row) => [keyOf(row), row])).values(),
]
const draftPersistDelayMilliseconds = 300

export const snapshotFromZeroRows = (
  viewerId: MemberId,
  rowsByWorkspace: readonly Partial<ZeroRows>[],
  drafts: readonly DraftRow[] = [],
) => {
  const rowsOf = <Table extends TableName>(table: Table) =>
    rowsByWorkspace.flatMap((rows) => rows[table] ?? []) as ZeroRows[Table]
  const workspaces = uniqueBy(rowsOf('workspaces'), (workspace) => workspace.workspaceId)
  const memberships = rowsOf('memberships')
  const messages = rowsOf('messages')
  const runtimeChatIds = new Set(rowsOf('chats').flatMap((chat) => (chat.type === 'runtime' ? [chat.id] : [])))
  const answeredMessageIds = new Set(messages.map((message) => message.replyToId))
  const messageIdBySeq = new Map(messages.map((message) => [`${message.chatId}/${message.seq}`, message.id]))
  const seqByMessageId = new Map(messages.map((message) => [`${message.chatId}/${message.id}`, message.seq]))
  const threadSeqOf = (message: ZeroRows['messages'][number]) =>
    seqByMessageId.get(`${message.chatId}/${message.replyToId}`) ?? message.seq
  const snapshot: Unbranded<Snapshot> = {
    workspaces: workspaces.map(({ workspaceId, name }) => ({ id: workspaceId, name })),
    memberships: uniqueBy(
      [...workspaces.map(({ workspaceId }) => ({ workspaceId, userId: viewerId, displayName: '' })), ...memberships],
      (membership) => `${membership.workspaceId}/${membership.userId}`,
    ).map(({ workspaceId, userId, displayName }) => ({ workspaceId, memberId: userId, displayName })),
    projects: rowsOf('projects').map(withoutCreatedAt),
    chats: rowsOf('chats').map(({ ownerKind, ownerUserId, ownerServiceIdentityId, mode, createdAt, ...chat }) => ({
      ...chat,
      ownerId: ownerUserId ?? '',
    })),
    messages: messages
      .toSorted(
        (first, second) =>
          first.chatId.localeCompare(second.chatId) ||
          threadSeqOf(first) - threadSeqOf(second) ||
          first.seq - second.seq,
      )
      .map(({ seq, replyToId, createdAt, editedAt, deletedAt, ...message }) => ({
        ...message,
        createdAt: isoOf(createdAt),
        editedAt: isoOrNull(editedAt),
        deletedAt: isoOrNull(deletedAt),
        needsReply:
          runtimeChatIds.has(message.chatId) &&
          message.kind === 'member' &&
          replyToId === null &&
          !answeredMessageIds.has(message.id),
      })),
    drafts,
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

const failureOf = (details: MutatorResultDetails) =>
  details.type === 'error' ? new Error(details.error.message) : undefined

export const createZeroStore = ({
  memberId,
  defaultWorkspaceId,
  cacheURL,
  fetchSession,
  kvStore,
  mutators,
  draftStorage,
}: ZeroStoreOptions) => {
  const draftKeyPrefix = `hq.draft:${memberId}:`
  const draftKeyOf = (draft: DraftRow) => `${draftKeyPrefix}${draft.workspaceId}:${draft.chatId}`
  const storedDraftKeys = () =>
    Array.from({ length: draftStorage?.length ?? 0 }, (_, index) => draftStorage?.key(index) ?? '').filter((key) =>
      key.startsWith(draftKeyPrefix),
    )
  let drafts: readonly DraftRow[] = storedDraftKeys().map((key) => JSON.parse(draftStorage?.getItem(key) ?? '{}'))
  let draftPersistTimer: ReturnType<typeof setTimeout> | undefined
  const persistDrafts = () => {
    const currentDraftKeys = new Set(drafts.map(draftKeyOf))
    for (const key of storedDraftKeys()) if (!currentDraftKeys.has(key)) draftStorage?.removeItem(key)
    for (const draft of drafts) draftStorage?.setItem(draftKeyOf(draft), JSON.stringify(draft))
  }
  const store = createStore(snapshotFromZeroRows(memberId, [], drafts))
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
      store.write(() => snapshotFromZeroRows(memberId, [...rowsByWorkspace.values()], drafts))
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
      mutators,
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
    write: (updater: (current: Snapshot) => Snapshot) =>
      store.write((current) => {
        const next = updater(current)
        const changedTables = (Object.keys(next) as (keyof Snapshot)[]).filter(
          (table) => next[table] !== current[table],
        )
        if (changedTables.some((table) => table !== 'drafts'))
          throw new Error('Writes through Zero go through mutators')
        if (next.drafts === current.drafts) return current
        drafts = next.drafts
        clearTimeout(draftPersistTimer)
        draftPersistTimer = setTimeout(persistDrafts, draftPersistDelayMilliseconds)
        return next
      }),
    whenLoaded: (workspaceId: WorkspaceId) => loadedOf(workspaceId).promise,
    mutate: async (workspaceId: WorkspaceId, request: Parameters<Zero['mutate']>[0]) => {
      await loadedOf(workspaceId).promise
      const zero = await zeroByWorkspace.get(workspaceId)
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
    signOut: async (workspaceId: WorkspaceId) => {
      signedOutWorkspaceIds.add(workspaceId)
      await (await close(workspaceId))?.delete()
    },
    signIn: async (workspaceId: WorkspaceId) => {
      signedOutWorkspaceIds.delete(workspaceId)
      await zeroByWorkspace.get(workspaceId)
      open(workspaceId)
      await loadedOf(workspaceId).promise
    },
    close: () => {
      isClosed = true
      return Promise.all([...zeroByWorkspace.keys()].map(async (workspaceId) => (await close(workspaceId))?.close()))
    },
  }
}
