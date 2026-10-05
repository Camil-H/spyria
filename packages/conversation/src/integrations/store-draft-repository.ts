import type { Draft, DraftRepository } from '../contracts/repositories.ts'

export const createStoreDraftRepository = (store: { replaceDraft: (draft: Draft) => void }): DraftRepository => ({
  replace: async (draft) => store.replaceDraft(draft),
})
