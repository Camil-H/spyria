import {
  type ConversationCommands,
  conversationMutators,
  conversationOperations,
  createStoreDraftRepository,
} from '@hq/conversation/server'
import type { Store } from '@hq/db'
import { createZeroStore, type WorkspaceSession } from '@hq/db/zero-store'
import { chatId, type IdGenerator, type MemberId, type WorkspaceId, workspaceId } from '@hq/kernel'
import { createHttpLlmCredentialAdder, type ProfileCommands, profileMutators } from '@hq/profile/server'
import type { Session } from '@hq/session'
import { createUuidIdGenerator, type WorkspaceCommands, workspaceMutators } from '@hq/workspace/server'
import { loadSessions, logOut, openSession, renew, signInWithPopup } from './auth.ts'

const zeroCacheURL = import.meta.env.VITE_ZERO_URL ?? 'http://localhost:4848'
const testStack = import.meta.env.DEV
  ? (window as Window & { hqTestStack?: { zeroCacheURL: string } }).hqTestStack
  : undefined
const sessionTokenByWorkspace = new Map<WorkspaceId, string>()
const remembered = (session: WorkspaceSession) => {
  sessionTokenByWorkspace.set(session.workspaceId, session.token)
  return session
}

const openZeroStore = async (
  memberId: MemberId,
  sessions: readonly WorkspaceSession[],
  defaultWorkspaceId: WorkspaceId,
) => {
  const store = createZeroStore({
    memberId,
    sessions: sessions.map(remembered),
    renew: async (workspaceId) => {
      const session = await renew(workspaceId)
      return session && remembered(session)
    },
    cacheURL: testStack?.zeroCacheURL ?? zeroCacheURL,
    mutators: { ...workspaceMutators, ...conversationMutators, ...profileMutators },
    draftStorage: localStorage,
  })
  await store.whenLoaded(defaultWorkspaceId)
  return store
}

type ZeroStore = Awaited<ReturnType<typeof openZeroStore>>
type CommandInput = { workspaceId: WorkspaceId }
type Mutator = (args: never) => Parameters<ZeroStore['mutate']>[1]

const commandsOf = <Commands>(entries: readonly (readonly [string, (input: CommandInput) => Promise<unknown>])[]) =>
  Object.fromEntries(entries) as Commands

const zeroCommandsOf = (zeroStore: ZeroStore, idGenerator: IdGenerator) => {
  const mutate = async (mutator: Mutator, input: CommandInput & { id?: string }) => {
    const id = input.id ?? idGenerator.next()
    const { confirmation } = await zeroStore.mutate(input.workspaceId, mutator({ ...input, id } as never))
    return { id, confirmation }
  }
  const entriesOf = (mutators: Record<string, Mutator>) =>
    Object.entries(mutators).map(
      ([name, mutator]) => [name, async (input: CommandInput) => (await mutate(mutator, input)).id] as const,
    )
  return { mutate, entriesOf }
}

const zeroWorkspaceCommands = (zeroStore: ZeroStore, idGenerator: IdGenerator) => {
  const { mutate, entriesOf } = zeroCommandsOf(zeroStore, idGenerator)
  return commandsOf<WorkspaceCommands>([
    ...entriesOf(workspaceMutators.workspace),
    [
      'createWorkspace',
      async (input) => {
        const { id, confirmation } = await mutate(workspaceMutators.workspace.createWorkspace, input)
        const bearerToken = sessionTokenByWorkspace.get(input.workspaceId) ?? ''
        const session = confirmation.then(() => openSession(workspaceId(id), bearerToken))
        zeroStore.signInToNew(workspaceId(id), session.then(remembered))
        return id
      },
    ],
  ])
}

const zeroConversationCommands = (zeroStore: ZeroStore, idGenerator: IdGenerator) => {
  const { mutate, entriesOf } = zeroCommandsOf(zeroStore, idGenerator)
  const drafts = createStoreDraftRepository(zeroStore)
  return commandsOf<ConversationCommands>([
    ...entriesOf(conversationMutators.conversation),
    ['saveDraft', (input) => conversationOperations.saveDraft({ drafts }, input as never)],
    [
      'startRuntimeFromMessage',
      async (input) => {
        const newChatId = chatId(idGenerator.next())
        await mutate(conversationMutators.conversation.startRuntimeFromMessage, {
          ...input,
          chatId: newChatId,
        } as never)
        return newChatId
      },
    ],
  ])
}

const addLlmCredentialAsMember = createHttpLlmCredentialAdder((workspaceId, path, body) =>
  fetch(path, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${sessionTokenByWorkspace.get(workspaceId)}`,
      'content-type': 'application/json',
    },
    body,
  }),
)

const zeroProfileCommands = (zeroStore: ZeroStore, idGenerator: IdGenerator) =>
  commandsOf<ProfileCommands>([
    ...zeroCommandsOf(zeroStore, idGenerator).entriesOf(profileMutators.profile),
    ['addLlmCredential', (input) => addLlmCredentialAsMember(input as never)],
  ])

export type Application = {
  store: Store
  session: Session
  workspaceCommands: WorkspaceCommands
  conversationCommands: ConversationCommands
  profileCommands: ProfileCommands
}

export const createApp = async (memberId: MemberId, sessions: readonly WorkspaceSession[]): Promise<Application> => {
  const defaultWorkspaceId = sessions[0]?.workspaceId ?? workspaceId('')
  const zeroStore = await openZeroStore(memberId, sessions, defaultWorkspaceId)
  const idGenerator = createUuidIdGenerator()
  return {
    store: zeroStore,
    session: {
      memberId,
      defaultWorkspaceId,
      signedInWorkspaceIds: zeroStore.signedInWorkspaceIds,
      subscribe: zeroStore.subscribe,
      signOut: async (workspaceId) => {
        await logOut(workspaceId).catch(console.error)
        await zeroStore.signOut(workspaceId)
      },
      signIn: async (workspaceId) => {
        if ((await signInWithPopup(workspaceId)).status !== 'signed_in') return
        const session = (await loadSessions()).sessions.find((live) => live.workspaceId === workspaceId)
        if (session) await zeroStore.signIn(remembered(session))
      },
    },
    workspaceCommands: zeroWorkspaceCommands(zeroStore, idGenerator),
    conversationCommands: zeroConversationCommands(zeroStore, idGenerator),
    profileCommands: zeroProfileCommands(zeroStore, idGenerator),
  }
}
