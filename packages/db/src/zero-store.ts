import type { MemberId, WorkspaceId } from '@hq/kernel'
import { type AnyMutatorRegistry, type MutatorResultDetails, type Row, Zero } from '@rocicorp/zero'
import type { DraftRow, Snapshot } from './schema.ts'
import { type Schema, schema } from './zero.ts'
import { queries, type ZeroContext } from './zero-queries.ts'

type TableName = keyof Schema['tables']
type ZeroRows = { [Table in TableName]: readonly Row<Schema['tables'][Table]>[] }
export type WorkspaceSession = { workspaceId: WorkspaceId; token: string; role: ZeroContext['role']; expiresAt: number }
type ZeroStoreOptions = {
  memberId: MemberId
  sessions: readonly WorkspaceSession[]
  renew: (workspaceId: WorkspaceId) => Promise<WorkspaceSession | undefined>
  cacheURL: string
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

const unmaterializedQueries = ['~', 'users', 'serviceIdentities'] as const
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
const renewalLeadMilliseconds = 60_000
const renewalRetryMilliseconds = 5_000

const snapshotFromZeroRows = (
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
  const seqByMessageId = new Map(messages.map((message) => [`${message.chatId}/${message.id}`, message.seq]))
  const threadSeqOf = (message: ZeroRows['messages'][number]) =>
    seqByMessageId.get(`${message.chatId}/${message.replyToId}`) ?? message.seq
  const snapshot: Unbranded<Snapshot> = {
    workspaces: workspaces.map(({ workspaceId, name }) => ({ id: workspaceId, name })),
    memberships: uniqueBy(
      [
        ...workspaces.map(({ workspaceId }) => ({ workspaceId, userId: viewerId, displayName: '', role: 'member' })),
        ...memberships,
      ],
      (membership) => `${membership.workspaceId}/${membership.userId}`,
    ).map(({ workspaceId, userId, displayName, role }) => ({ workspaceId, memberId: userId, displayName, role })),
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
      .map(({ replyToId, createdAt, editedAt, deletedAt, ...message }) => ({
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
    readMarkers: rowsOf('readMarkers').map(withMemberId),
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
    runtimeHosts: rowsOf('runtimeHosts').map(({ lastSeenAt, createdBy, createdAt, removedAt, ...host }) => host),
  }
  return snapshot as Snapshot
}

export type Store = ReturnType<typeof createZeroStore>

const failureOf = (details: MutatorResultDetails) =>
  details.type === 'error' ? new Error(details.error.message) : undefined

export const createZeroStore = ({
  memberId,
  sessions,
  renew,
  cacheURL,
  kvStore,
  mutators,
  draftStorage,
}: ZeroStoreOptions) => {
  const draftKeyPrefix = `hq.draft:${memberId}:`
  const draftKeyOf = (draft: DraftRow) => `${draftKeyPrefix}${draft.workspaceId}:${draft.chatId}`
  let drafts: readonly DraftRow[] = Array.from({ length: draftStorage?.length ?? 0 }, (_, index) =>
    draftStorage?.key(index),
  ).flatMap((key) => (key?.startsWith(draftKeyPrefix) ? [JSON.parse(draftStorage?.getItem(key) ?? '{}')] : []))
  let snapshot = snapshotFromZeroRows(memberId, [], drafts)
  const listeners = new Set<() => void>()
  const rowsByWorkspace = new Map<WorkspaceId, Partial<ZeroRows>>()
  const zeroByWorkspace = new Map<WorkspaceId, Zero>()
  const tokenByWorkspace = new Map<WorkspaceId, string>()
  const loadedByWorkspace = new Map<WorkspaceId, PromiseWithResolvers<void>>()
  const renewalTimerByWorkspace = new Map<WorkspaceId, ReturnType<typeof setTimeout>>()
  let signedInWorkspaceIds: ReadonlySet<WorkspaceId> = new Set(sessions.map((session) => session.workspaceId))
  let isPublishScheduled = false
  const publish = () => {
    if (isPublishScheduled) return
    isPublishScheduled = true
    queueMicrotask(() => {
      isPublishScheduled = false
      snapshot = snapshotFromZeroRows(memberId, [...rowsByWorkspace.values()], drafts)
      for (const listener of listeners) listener()
    })
  }
  const loadedOf = (workspaceId: WorkspaceId) => {
    const loaded = loadedByWorkspace.get(workspaceId) ?? Promise.withResolvers<void>()
    loadedByWorkspace.set(workspaceId, loaded)
    return loaded
  }
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
    if (renewed === null) return renewLater(workspaceId, renewalRetryMilliseconds)
    if (renewed === undefined) return signOut(workspaceId)
    scheduleRenewal(renewed)
    tokenByWorkspace.set(workspaceId, renewed.token)
    await zero.connection.connect({ auth: renewed.token })
  }
  const connect = (session: WorkspaceSession) => {
    const { workspaceId, token, role } = session
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
    zeroByWorkspace.set(workspaceId, zero)
    tokenByWorkspace.set(workspaceId, token)
    for (const table of materializedTables)
      zero
        .materialize((queries[table] as () => Parameters<typeof zero.materialize>[0])())
        .addListener((data, result) => {
          if (rowsByWorkspace.get(workspaceId) !== rows) return
          rows[table] = (data as readonly object[]).map((row) => Object.fromEntries(Object.entries(row))) as never
          publish()
          if (result === 'complete') completeTables.add(table)
          if (completeTables.size === materializedTables.length) loadedOf(workspaceId).resolve()
        })
    zero.connection.state.subscribe((state) => {
      if (state.name === 'needs-auth') renewNow(workspaceId)
    })
    scheduleRenewal(session)
  }
  const close = (workspaceId: WorkspaceId) => {
    const zero = zeroByWorkspace.get(workspaceId)
    clearTimeout(renewalTimerByWorkspace.get(workspaceId))
    zeroByWorkspace.delete(workspaceId)
    loadedByWorkspace.delete(workspaceId)
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
    replaceDraft: (draft: DraftRow) => {
      const isReplaced = (stored: DraftRow) =>
        stored.workspaceId === draft.workspaceId && stored.chatId === draft.chatId && stored.memberId === draft.memberId
      if ((drafts.find(isReplaced)?.text ?? '') === draft.text) return
      drafts = [...drafts.filter((stored) => !isReplaced(stored)), ...(draft.text === '' ? [] : [draft])]
      if (draft.text === '') draftStorage?.removeItem(draftKeyOf(draft))
      else draftStorage?.setItem(draftKeyOf(draft), JSON.stringify(draft))
      publish()
    },
    whenLoaded: (workspaceId: WorkspaceId) => loadedOf(workspaceId).promise,
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
    tokenOf: (workspaceId: WorkspaceId) => tokenByWorkspace.get(workspaceId) ?? '',
    signOut,
    signIn: async (session: WorkspaceSession) => {
      if (!zeroByWorkspace.has(session.workspaceId)) connect(session)
      await loadedOf(session.workspaceId).promise
      markSignedIn(session.workspaceId)
    },
    signInToNew: (workspaceId: WorkspaceId, session: Promise<WorkspaceSession>) => {
      markSignedIn(workspaceId)
      session.then(connect, (error) => {
        close(workspaceId)
        console.error(error)
      })
    },
    close: () => Promise.all([...zeroByWorkspace.keys()].map((workspaceId) => close(workspaceId)?.close())),
  }
}
