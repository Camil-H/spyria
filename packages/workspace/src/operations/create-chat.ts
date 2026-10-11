import { chatId, type MemberId, type ProjectId, type WorkspaceId } from '@hq/kernel'
import type { Transactor } from '../contracts/transactor.ts'
import { type Chat, type ChatKind, movedChat, sessionFieldsOf } from '../domain/chat.ts'
import type { Name } from '../domain/name.ts'

type Dependencies = { transactor: Transactor }
type Input = {
  id: string
  workspaceId: WorkspaceId
  ownerId: MemberId
  kind: ChatKind
  name: Name
  projectId: ProjectId | null
}

export const createChat = ({ transactor }: Dependencies, { id, workspaceId, ownerId, kind, name, projectId }: Input) =>
  transactor.run(async (unitOfWork) => {
    const looseChat: Chat = {
      id: chatId(id),
      workspaceId,
      projectId: null,
      ...sessionFieldsOf(kind),
      name,
      ownerId,
      archived: false,
      model: null,
      reasoningEffort: null,
      defaultModel: kind === 'runtime' ? await unitOfWork.memberModels.defaultModelOf(ownerId) : null,
      gitBranch: null,
      originChatId: null,
    }
    const project = projectId ? await unitOfWork.projects.get(projectId) : null
    await unitOfWork.chats.record({ type: 'chat.created', chat: movedChat(looseChat, project), actorId: ownerId })
  })
