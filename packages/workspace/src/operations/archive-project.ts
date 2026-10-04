import type { MemberId, ProjectId } from '@hq/kernel'
import type { Transactor } from '../contracts/transactor.ts'
import { archivedProject, type ChatsPolicy } from '../domain/project.ts'

type Dependencies = { transactor: Transactor }
type Input = { projectId: ProjectId; chatsPolicy: ChatsPolicy; actorId: MemberId }

export const archiveProject = ({ transactor }: Dependencies, { projectId, chatsPolicy, actorId }: Input) =>
  transactor.run(async (unitOfWork) => {
    const project = await unitOfWork.projects.get(projectId)
    const chats = await unitOfWork.chats.listByProject(projectId)
    const archived = archivedProject(project, chats, chatsPolicy)
    await unitOfWork.projects.save(archived.project)
    const type = chatsPolicy === 'archive' ? 'chat.archived' : 'chat.moved'
    for (const chat of archived.chats) await unitOfWork.chats.record({ type, chat, actorId })
  })
