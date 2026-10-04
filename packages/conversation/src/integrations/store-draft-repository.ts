import type { DraftRow, Store } from '@hq/db'
import type { DraftRepository } from '../contracts/repositories.ts'

const isSameDraftOwner = (draft: DraftRow, chatId: string, memberId: string) =>
  draft.chatId === chatId && draft.memberId === memberId

export const createStoreDraftRepository = (store: Store): DraftRepository => ({
  save: async (draft) =>
    store.write((current) => {
      const stored = current.drafts.find((row) => isSameDraftOwner(row, draft.chatId, draft.memberId))
      if (stored?.text === draft.text) return current
      return { ...current, drafts: [...current.drafts.filter((row) => row !== stored), draft] }
    }),
  remove: async (chatId, memberId) =>
    store.write((current) =>
      current.drafts.some((row) => isSameDraftOwner(row, chatId, memberId))
        ? { ...current, drafts: current.drafts.filter((row) => !isSameDraftOwner(row, chatId, memberId)) }
        : current,
    ),
})
