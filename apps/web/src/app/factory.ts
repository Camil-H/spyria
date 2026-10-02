import { createMockSnapshot, createStore, currentMemberId, defaultWorkspaceId, type Store } from '@hq/db'
import type { ConversationDependencies } from '../conversation/entrypoints/providers.tsx'
import { createStoreTransactor as createConversationTransactor } from '../conversation/integrations/store-transactor.ts'
import { createSystemClock } from '../conversation/integrations/system-clock.ts'
import { createWorkspaceRuntimeChatStarter } from '../conversation/integrations/workspace-runtime-chat-starter.ts'
import type { ProfileDependencies } from '../profile/entrypoints/providers.tsx'
import { createSimulatedPlanLoginProbe } from '../profile/integrations/simulated-plan-login-probe.ts'
import { createStoreTransactor as createProfileTransactor } from '../profile/integrations/store-transactor.ts'
import type { WorkspaceDependencies } from '../workspace/entrypoints/providers.tsx'
import { createStoreTransactor } from '../workspace/integrations/store-transactor.ts'
import { createUuidIdGenerator } from '../workspace/integrations/uuid-id-generator.ts'
import type { Session } from './session.tsx'

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
      planLoginProbe: createSimulatedPlanLoginProbe(),
    },
  }
}
