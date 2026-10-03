import type { ConversationDependencies } from '@hq/conversation'
import {
  createStoreTransactor as createConversationTransactor,
  createSystemClock,
  createWorkspaceRuntimeChatStarter,
} from '@hq/conversation/core'
import { createMockSnapshot, createStore, currentMemberId, defaultWorkspaceId, type Store } from '@hq/db'
import type { ProfileDependencies } from '@hq/profile'
import { createStoreTransactor as createProfileTransactor } from '@hq/profile/core'
import type { Session } from '@hq/session'
import type { WorkspaceDependencies } from '@hq/workspace'
import { createStoreTransactor, createUuidIdGenerator } from '@hq/workspace/core'

const defaultRuntimeModel = 'Claude Sonnet 5.5'
const defaultReasoningEffort = 'Medium'

export type Application = {
  store: Store
  session: Session
  workspaceDependencies: WorkspaceDependencies
  conversationDependencies: ConversationDependencies
  profileDependencies: ProfileDependencies
}

export const createApp = (): Application => {
  const store = createStore(createMockSnapshot())
  const idGenerator = createUuidIdGenerator()
  const workspaceDependencies = {
    transactor: createStoreTransactor(store),
    idGenerator,
    defaultRuntimeModel,
    defaultReasoningEffort,
  }
  return {
    store,
    session: { memberId: currentMemberId, defaultWorkspaceId },
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
