import { type ChatVisibility, chatId, type MemberId, type ProjectId, visibilityOf, type WorkspaceId } from '@hq/kernel'
import type { WorkspaceTransactor } from '../contracts/transactor.ts'
import { type Chat, movedChat, visibleChat } from '../domain/chat.ts'
import type { Name } from '../domain/name.ts'

type Dependencies = { transactor: WorkspaceTransactor }
type Input = {
  id: string
  workspaceId: WorkspaceId
  ownerId: MemberId
  type: Chat['type']
  visibility?: ChatVisibility
  name: Name
  projectId: ProjectId | null
}

export const createChat = (
  { transactor }: Dependencies,
  { id, workspaceId, ownerId, type, visibility, name, projectId }: Input,
) =>
  transactor.run(async (unitOfWork) => {
    const looseChat: Chat = {
      id: chatId(id),
      workspaceId,
      projectId: null,
      type,
      visibility: visibilityOf(type),
      name,
      ownerId,
      archived: false,
      model: null,
      reasoningEffort: null,
      gitBranch: null,
      originChatId: null,
    }
    const project = projectId ? await unitOfWork.projects.get(projectId) : null
    await unitOfWork.chats.record({
      type: 'chat.created',
      chat: movedChat(visibility ? visibleChat(looseChat, visibility) : looseChat, project),
      actorId: ownerId,
    })
  })
