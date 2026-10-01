import { createMockSnapshot, createStore, currentMemberId, defaultWorkspaceId, type Store } from '@hq/db'
import type { WorkspaceDependencies } from '../workspace/entrypoints/providers.tsx'
import { createStoreTransactor } from '../workspace/integrations/store-transactor.ts'
import { createUuidIdGenerator } from '../workspace/integrations/uuid-id-generator.ts'
import type { Session } from './session.tsx'

export type Application = { store: Store; session: Session; workspaceDependencies: WorkspaceDependencies }

export const createApp = (): Application => {
  const store = createStore(createMockSnapshot())
  return {
    store,
    session: { memberId: currentMemberId, defaultWorkspaceId },
    workspaceDependencies: { transactor: createStoreTransactor(store), idGenerator: createUuidIdGenerator() },
  }
}
