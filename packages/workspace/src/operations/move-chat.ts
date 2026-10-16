import type { ChatId, MemberId, ProjectId } from '@hq/kernel'
import type { WorkspaceTransactor } from '../contracts/transactor.ts'
import { movedChat } from '../domain/chat.ts'

type Dependencies = { transactor: WorkspaceTransactor }
type Input = { chatId: ChatId; projectId: ProjectId | null; actorId: MemberId }

export const moveChat = ({ transactor }: Dependencies, { chatId, projectId, actorId }: Input) =>
  transactor.run(async (unitOfWork) => {
    const chat = await unitOfWork.chats.get(chatId)
    const project = projectId ? await unitOfWork.projects.get(projectId) : null
    await unitOfWork.chats.record({ type: 'chat.moved', chat: movedChat(chat, project), actorId })
  })
