import type { ChatId } from '@spyria/kernel'

export type SidebarPlacement = 'before' | 'after'

export const sidebarOrderWith = (
  chatIds: readonly ChatId[],
  placedChatId: ChatId,
  targetChatId: ChatId,
  placement: SidebarPlacement,
) => {
  if (placedChatId === targetChatId) return [...chatIds]
  const otherChatIds = chatIds.filter((id) => id !== placedChatId)
  const targetIndex = otherChatIds.indexOf(targetChatId)
  if (targetIndex === -1) return [...otherChatIds, placedChatId]
  return otherChatIds.toSpliced(targetIndex + (placement === 'after' ? 1 : 0), 0, placedChatId)
}
