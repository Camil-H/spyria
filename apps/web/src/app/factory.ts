import {
  type ConversationCommands,
  conversationMutators,
  conversationOperations,
  createStoreDraftRepository,
} from '@hq/conversation/server'
import { currentMemberId, defaultWorkspaceId, type Store } from '@hq/db'
import { createZeroStore } from '@hq/db/zero-store'
import { chatId, type IdGenerator, type WorkspaceId, workspaceId } from '@hq/kernel'
import { createHttpLlmCredentialAdder, type ProfileCommands, profileMutators } from '@hq/profile/server'
import type { Session } from '@hq/session'
import { createUuidIdGenerator, type WorkspaceCommands, workspaceMutators } from '@hq/workspace/server'

const zeroCacheURL = import.meta.env.VITE_ZERO_URL ?? 'http://localhost:4848'
type TestStack = { zeroCacheURL: string; databaseName: string }
const testStack = import.meta.env.DEV ? (window as Window & { hqTestStack?: TestStack }).hqTestStack : undefined
const sessionTokenByWorkspace = new Map<WorkspaceId, string>()

const openZeroStore = async () => {
  const store = createZeroStore({
    memberId: currentMemberId,
    defaultWorkspaceId,
    cacheURL: testStack?.zeroCacheURL ?? zeroCacheURL,
    mutators: { ...workspaceMutators, ...conversationMutators, ...profileMutators },
    draftStorage: localStorage,
    fetchSession: async (workspaceId) => {
      const response = await fetch('/auth/dev-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, userId: currentMemberId, db: testStack?.databaseName }),
      })
      if (!response.ok) throw new Error(`The dev token for ${workspaceId} was refused with ${response.status}`)
      const session = await response.json()
      sessionTokenByWorkspace.set(workspaceId, session.token)
      return session
    },
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
        confirmation.then(
          () => zeroStore.signIn(workspaceId(id)),
          () => {},
        )
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

export const createApp = async (): Promise<Application> => {
  const zeroStore = await openZeroStore()
  const idGenerator = createUuidIdGenerator()
  return {
    store: zeroStore,
    session: {
      memberId: currentMemberId,
      defaultWorkspaceId,
      onSignOut: zeroStore.signOut,
      onSignIn: zeroStore.signIn,
    },
    workspaceCommands: zeroWorkspaceCommands(zeroStore, idGenerator),
    conversationCommands: zeroConversationCommands(zeroStore, idGenerator),
    profileCommands: zeroProfileCommands(zeroStore, idGenerator),
  }
}
