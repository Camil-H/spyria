import { chatId, type MemberId, type ProjectId, type WorkspaceId } from '@hq/kernel'
import type { IdGenerator } from '../contracts/id-generator.ts'
import type { Transactor } from '../contracts/transactor.ts'
import { type Chat, moveChat } from '../domain/chat.ts'
import type { Name } from '../domain/name.ts'

type Dependencies = { transactor: Transactor; idGenerator: IdGenerator; defaultRuntimeModel: string }
type Input = {
  workspaceId: WorkspaceId
  ownerId: MemberId
  type: Chat['type']
  name: Name
  projectId: ProjectId | null
}

export const createChat = ({ transactor, idGenerator, defaultRuntimeModel }: Dependencies, input: Input) =>
  transactor.run(async (unitOfWork) => {
    const { projectId, ...fields } = input
    const looseChat: Chat = {
      ...fields,
      model: input.type === 'runtime' ? defaultRuntimeModel : null,
      originChatId: null,
      id: chatId(idGenerator.next()),
      projectId: null,
      archived: false,
    }
    const project = projectId ? await unitOfWork.projects.get(projectId) : null
    await unitOfWork.chats.add(moveChat(looseChat, project))
    return looseChat.id
  })
