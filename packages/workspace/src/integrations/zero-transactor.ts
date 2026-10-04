import { type Chat as ChatRow, type Project as ProjectRow, zql } from '@hq/db/zero'
import type { ZeroContext } from '@hq/db/zero-queries'
import { type ChatId, chatId, memberId, type ProjectId, projectId, workspaceId } from '@hq/kernel'
import type { Transaction } from '@rocicorp/zero'
import type { Transactor, UnitOfWork } from '../contracts/transactor.ts'
import type { Chat } from '../domain/chat.ts'
import { ChatNotFound, ForeignWorkspace, ProjectNotFound } from '../domain/errors.ts'
import { Name } from '../domain/name.ts'
import type { Project } from '../domain/project.ts'

const toProject = ({ createdAt, ...row }: ProjectRow): Project => ({
  ...row,
  id: projectId(row.id),
  workspaceId: workspaceId(row.workspaceId),
  name: Name(row.name),
})

const toChat = ({ createdAt, mode, ownerKind, ownerUserId, ownerServiceIdentityId, ...row }: ChatRow): Chat => ({
  ...row,
  id: chatId(row.id),
  workspaceId: workspaceId(row.workspaceId),
  projectId: row.projectId === null ? null : projectId(row.projectId),
  originChatId: row.originChatId === null ? null : chatId(row.originChatId),
  ownerId: memberId(ownerUserId ?? ''),
  name: Name(row.name),
})

const chatFields = ({ ownerId, ...chat }: Chat) => chat

export const createZeroTransactor = (tx: Transaction, context: ZeroContext): Transactor => {
  const createdWorkspaceIds = new Set<string>()
  const inContextWorkspace = <Row extends { workspaceId: string }>(row: Row) => {
    if (row.workspaceId !== context.workspaceId) throw new ForeignWorkspace()
    return row
  }
  const findProject = (id: ProjectId) =>
    tx.run(zql.projects.where('workspaceId', context.workspaceId).where('id', id).one())
  const findChat = (id: ChatId) => tx.run(zql.chats.where('workspaceId', context.workspaceId).where('id', id).one())
  const unitOfWork: UnitOfWork = {
    workspaces: {
      add: async ({ id, name }) => {
        if (await tx.run(zql.workspaces.where('workspaceId', id).one())) throw new ForeignWorkspace()
        createdWorkspaceIds.add(id)
        await tx.mutate.workspaces.insert({ workspaceId: id, name, createdBy: context.userId, createdAt: Date.now() })
      },
    },
    memberships: {
      add: async (membership) => {
        if (!createdWorkspaceIds.has(membership.workspaceId) || membership.memberId !== context.userId)
          throw new ForeignWorkspace()
        const creator = await tx.run(
          zql.memberships.where('workspaceId', context.workspaceId).where('userId', context.userId).one(),
        )
        await tx.mutate.memberships.insert({
          workspaceId: membership.workspaceId,
          userId: membership.memberId,
          role: 'admin',
          displayName: creator?.displayName ?? '',
        })
      },
    },
    projects: {
      get: async (id) => {
        const row = await findProject(id)
        if (!row) throw new ProjectNotFound(id)
        return toProject(row)
      },
      add: (project) => tx.mutate.projects.insert({ ...inContextWorkspace(project), createdAt: Date.now() }),
      save: (project) => tx.mutate.projects.update(inContextWorkspace(project)),
    },
    chats: {
      get: async (id) => {
        const row = await findChat(id)
        if (!row) throw new ChatNotFound(id)
        return toChat(row)
      },
      add: (chat) =>
        tx.mutate.chats.insert({
          ...chatFields(inContextWorkspace(chat)),
          mode: null,
          ownerKind: 'user',
          ownerUserId: chat.ownerId,
          ownerServiceIdentityId: null,
          createdAt: Date.now(),
        }),
      save: (chat) => tx.mutate.chats.update(chatFields(inContextWorkspace(chat))),
      listByProject: async (id) =>
        (await tx.run(zql.chats.where('workspaceId', context.workspaceId).where('projectId', id))).map(toChat),
    },
  }
  return { run: (work) => work(unitOfWork) }
}
