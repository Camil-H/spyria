import type { ConversationDependencies } from '@hq/conversation'
import {
  createStoreTransactor as createConversationTransactor,
  createSystemClock,
  createWorkspaceRuntimeChatStarter,
} from '@hq/conversation/server'
import { createMockSnapshot, createStore, currentMemberId, defaultWorkspaceId, type Store } from '@hq/db'
import type { ProfileDependencies } from '@hq/profile'
import { createStoreTransactor as createProfileTransactor } from '@hq/profile/server'
import type { Session } from '@hq/session'
import type { WorkspaceDependencies } from '@hq/workspace'
import { createStoreTransactor, createUuidIdGenerator } from '@hq/workspace/server'

const defaultRuntimeModel = 'Claude Sonnet 5.5'
const defaultReasoningEffort = 'Medium'
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

export type Application = {
  store: Store
  session: Session
  workspaceDependencies: WorkspaceDependencies
  conversationDependencies: ConversationDependencies
  profileDependencies: ProfileDependencies
}

export const createApp = async (): Promise<Application> => {
  const zeroStore = dataSource === 'zero' ? await openZeroStore() : undefined
  const store = zeroStore ?? createStore(createMockSnapshot())
  const idGenerator = createUuidIdGenerator()
  const workspaceDependencies = {
    transactor: createStoreTransactor(store),
    idGenerator,
    defaultRuntimeModel,
    defaultReasoningEffort,
  }
  return {
    store,
    session: {
      memberId: currentMemberId,
      defaultWorkspaceId,
      onSignOut: zeroStore?.signOut,
      onSignIn: zeroStore?.signIn,
    },
    workspaceDependencies,
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
