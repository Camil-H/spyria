import { type ChatId, chatId, type ProjectId, type WorkspaceId } from '@spyria/kernel'
import type { useGuardedAction } from '@spyria/ui'
import { type DragEvent, useState } from 'react'
import { useWorkspaceCommands } from './providers.tsx'

const chatDragType = 'application/x-spyria-chat'

export const chatDropTargetClass = 'rounded-md data-[drop-target]:bg-hover'

export const startChatDrag = (draggedChatId: ChatId) => (event: DragEvent) => {
  event.dataTransfer.setData(chatDragType, draggedChatId)
  event.dataTransfer.effectAllowed = 'move'
}

export const useChatDrop = ({
  workspaceId,
  projectId,
  chats,
  chatAction,
}: {
  workspaceId: WorkspaceId
  projectId: ProjectId | null
  chats: readonly { id: ChatId }[]
  chatAction: ReturnType<typeof useGuardedAction>
}) => {
  const commands = useWorkspaceCommands()
  const [isDropTarget, setIsDropTarget] = useState(false)
  return {
    'data-drop-target': isDropTarget || undefined,
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes(chatDragType)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setIsDropTarget(true)
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDropTarget(false)
    },
    onDrop: (event: DragEvent) => {
      setIsDropTarget(false)
      const droppedChatId = event.dataTransfer.getData(chatDragType)
      if (!droppedChatId) return
      event.preventDefault()
      if (chats.some(({ id }) => id === droppedChatId)) return
      chatAction.run(() => commands.moveChat({ workspaceId, chatId: chatId(droppedChatId), projectId }))
    },
  }
}
