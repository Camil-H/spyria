import type { ChatId, ProjectId } from '@hq/kernel'
import type { Transactor } from '../contracts/transactor.ts'
import { movedChat } from '../domain/chat.ts'

type Dependencies = { transactor: Transactor }
type Input = { chatId: ChatId; projectId: ProjectId | null }

export const moveChat = ({ transactor }: Dependencies, { chatId, projectId }: Input) =>
  transactor.run(async (unitOfWork) => {
    const chat = await unitOfWork.chats.get(chatId)
    const project = projectId ? await unitOfWork.projects.get(projectId) : null
    await unitOfWork.chats.save(movedChat(chat, project))
  })
