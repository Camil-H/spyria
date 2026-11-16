import type { ChatId, ProjectId, WorkspaceId } from '@spyria/kernel'
import type { useGuardedAction } from '@spyria/ui'
import { type DragEvent, useState } from 'react'
import { type SidebarPlacement, sidebarOrderWith } from '../domain/sidebar.ts'
import { useWorkspaceCommands } from './providers.tsx'

const chatDragType = 'application/x-spyria-chat'

type DraggedChat = { id: ChatId; canAdmin: boolean }
let draggedChat: DraggedChat | null = null

export const chatDropTargetClass = 'rounded-md data-[drop-target]:bg-hover'

export type ChatGroup = Readonly<{ projectId: ProjectId | null; chatIds: readonly ChatId[] }>
type ChatDropOptions = {
  workspaceId: WorkspaceId
  group: ChatGroup
  chatAction: ReturnType<typeof useGuardedAction>
}

export const chatDragHandlers = (chat: DraggedChat) => ({
  onDragStart: (event: DragEvent) => {
    draggedChat = chat
    event.dataTransfer.setData(chatDragType, chat.id)
    event.dataTransfer.effectAllowed = 'move'
  },
  onDragEnd: () => {
    draggedChat = null
  },
})

const canDropIn = (group: ChatGroup, chat: DraggedChat | null): chat is DraggedChat =>
  chat !== null && (chat.canAdmin || group.chatIds.includes(chat.id))

const usePlaceChat = ({ workspaceId, group, chatAction }: ChatDropOptions) => {
  const commands = useWorkspaceCommands()
  return (placedChatId: ChatId, chatIds: readonly ChatId[]) =>
    chatAction.run(async () => {
      if (!group.chatIds.includes(placedChatId))
        await commands.moveChat({ workspaceId, chatId: placedChatId, projectId: group.projectId })
      await commands.reorderChats({ workspaceId, chatIds })
    })
}

export const useChatDrop = (options: ChatDropOptions) => {
  const placeChat = usePlaceChat(options)
  const [isDropTarget, setIsDropTarget] = useState(false)
  const isMovingIn = () => canDropIn(options.group, draggedChat) && !options.group.chatIds.includes(draggedChat.id)
  return {
    'data-drop-target': isDropTarget || undefined,
    onDropCapture: () => setIsDropTarget(false),
    onDragOver: (event: DragEvent) => {
      if (!isMovingIn()) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setIsDropTarget(true)
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDropTarget(false)
    },
    onDrop: (event: DragEvent) => {
      setIsDropTarget(false)
      const chat = draggedChat
      if (!chat || !isMovingIn()) return
      event.preventDefault()
      placeChat(chat.id, [...options.group.chatIds, chat.id])
    },
  }
}

const placementAt = (event: DragEvent): SidebarPlacement => {
  const { top, height } = event.currentTarget.getBoundingClientRect()
  return event.clientY < top + height / 2 ? 'before' : 'after'
}

export const useChatRowDrop = (targetChatId: ChatId, options: ChatDropOptions) => {
  const placeChat = usePlaceChat(options)
  const [placement, setPlacement] = useState<SidebarPlacement | null>(null)
  return {
    placement,
    onDragOver: (event: DragEvent) => {
      if (!canDropIn(options.group, draggedChat)) return
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'move'
      setPlacement(draggedChat.id === targetChatId ? null : placementAt(event))
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPlacement(null)
    },
    onDrop: (event: DragEvent) => {
      setPlacement(null)
      const chat = draggedChat
      if (!canDropIn(options.group, chat)) return
      event.preventDefault()
      event.stopPropagation()
      placeChat(chat.id, sidebarOrderWith(options.group.chatIds, chat.id, targetChatId, placementAt(event)))
    },
  }
}
