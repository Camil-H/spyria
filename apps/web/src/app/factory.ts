import { startMockAgent } from '@hq/conversation'
import {
  type ConversationCommands,
  conversationMutators,
  conversationOperations,
  createStoreTransactor as createConversationTransactor,
  createStoreDraftRepository,
  createSystemClock,
  createWorkspaceRuntimeChatStarter,
} from '@hq/conversation/server'
import { createMockSnapshot, createStore, currentMemberId, defaultWorkspaceId, type Store } from '@hq/db'
import { chatId, type IdGenerator, type WorkspaceId, workspaceId } from '@hq/kernel'
import type { ProfileDependencies } from '@hq/profile'
import { createStoreTransactor as createProfileTransactor } from '@hq/profile/server'
import type { Session } from '@hq/session'
import {
  createStoreTransactor,
  createUuidIdGenerator,
  runtimeChatDefaults,
  type WorkspaceCommands,
  workspaceMutators,
  workspaceOperations,
} from '@hq/workspace/server'

const dataSource = import.meta.env.VITE_DATA ?? 'memory'
const zeroCacheURL = import.meta.env.VITE_ZERO_URL ?? 'http://localhost:4848'
type TestStack = { zeroCacheURL: string; databaseName: string }
const testStack = import.meta.env.DEV ? (window as Window & { hqTestStack?: TestStack }).hqTestStack : undefined

const openZeroStore = async () => {
  const { createZeroStore } = await import('@hq/db/zero-store')
  const store = createZeroStore({
    memberId: currentMemberId,
    defaultWorkspaceId,
    cacheURL: testStack?.zeroCacheURL ?? zeroCacheURL,
    mutators: { ...workspaceMutators, ...conversationMutators },
    draftStorage: localStorage,
    fetchSession: async (workspaceId) => {
      const response = await fetch('/auth/dev-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, userId: currentMemberId, db: testStack?.databaseName }),
      })
      if (!response.ok) throw new Error(`The dev token for ${workspaceId} was refused with ${response.status}`)
      return response.json()
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

export type Application = {
  store: Store
  session: Session
  workspaceCommands: WorkspaceCommands
  conversationCommands: ConversationCommands
  profileDependencies: ProfileDependencies
  startMockAgent?: () => void
}

export const createApp = async (): Promise<Application> => {
  const zeroStore = dataSource === 'zero' ? await openZeroStore() : undefined
  const store = zeroStore ?? createStore(createMockSnapshot())
  const idGenerator = createUuidIdGenerator()
  const workspaceDependencies = { transactor: createStoreTransactor(store), idGenerator, ...runtimeChatDefaults }
  const conversationDependencies = {
    transactor: createConversationTransactor(store),
    idGenerator,
    clock: createSystemClock(),
    runtimeChatStarter: createWorkspaceRuntimeChatStarter(workspaceDependencies),
    drafts: createStoreDraftRepository(store),
  }
  const bound = <Commands>(
    operations: Record<string, (dependencies: never, input: never) => Promise<unknown>>,
    dependencies: object,
  ) =>
    commandsOf<Commands>(
      Object.entries(operations).map(([name, operation]) => [
        name,
        (input) => operation(dependencies as never, input as never),
      ]),
    )
  return {
    store,
    session: {
      memberId: currentMemberId,
      defaultWorkspaceId,
      onSignOut: zeroStore?.signOut,
      onSignIn: zeroStore?.signIn,
    },
    workspaceCommands: zeroStore
      ? zeroWorkspaceCommands(zeroStore, idGenerator)
      : bound<WorkspaceCommands>(workspaceOperations, workspaceDependencies),
    conversationCommands: zeroStore
      ? zeroConversationCommands(zeroStore, idGenerator)
      : bound<ConversationCommands>(conversationOperations, conversationDependencies),
    profileDependencies: {
      transactor: createProfileTransactor(store),
      idGenerator,
    },
    startMockAgent: zeroStore ? undefined : () => startMockAgent(store, conversationDependencies),
  }
}
