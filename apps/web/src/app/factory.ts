import type { ConversationDependencies } from '@hq/conversation'
import {
  createStoreTransactor as createConversationTransactor,
  createSystemClock,
  createWorkspaceRuntimeChatStarter,
} from '@hq/conversation/server'
import { createMockSnapshot, createStore, currentMemberId, defaultWorkspaceId, type Store } from '@hq/db'
import { type IdGenerator, type WorkspaceId, workspaceId } from '@hq/kernel'
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
    mutators: workspaceMutators,
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

const commandsOf = <Commands>(entries: readonly (readonly [string, (input: CommandInput) => Promise<unknown>])[]) =>
  Object.fromEntries(entries) as Commands

const zeroWorkspaceCommands = (zeroStore: ZeroStore, idGenerator: IdGenerator) => {
  const mutate = async (mutator: (args: never) => Parameters<ZeroStore['mutate']>[1], input: CommandInput) => {
    const id = idGenerator.next()
    const { confirmation } = await zeroStore.mutate(input.workspaceId, mutator({ ...input, id } as never))
    return { id, confirmation }
  }
  return commandsOf<WorkspaceCommands>([
    ...Object.entries(workspaceMutators.workspace).map(
      ([name, mutator]) => [name, async (input: CommandInput) => (await mutate(mutator, input)).id] as const,
    ),
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

export type Application = {
  store: Store
  session: Session
  workspaceCommands: WorkspaceCommands
  conversationDependencies: ConversationDependencies
  profileDependencies: ProfileDependencies
}

export const createApp = async (): Promise<Application> => {
  const zeroStore = dataSource === 'zero' ? await openZeroStore() : undefined
  const store = zeroStore ?? createStore(createMockSnapshot())
  const idGenerator = createUuidIdGenerator()
  const workspaceDependencies = { transactor: createStoreTransactor(store), idGenerator, ...runtimeChatDefaults }
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
      : commandsOf<WorkspaceCommands>(
          Object.entries(workspaceOperations).map(([name, operation]) => [
            name,
            (input) => operation(workspaceDependencies, input as never),
          ]),
        ),
    conversationDependencies: {
      transactor: createConversationTransactor(store),
      idGenerator,
      clock: createSystemClock(),
      runtimeChatStarter: createWorkspaceRuntimeChatStarter(workspaceDependencies),
    },
    profileDependencies: {
      transactor: createProfileTransactor(store),
      idGenerator,
    },
  }
}
