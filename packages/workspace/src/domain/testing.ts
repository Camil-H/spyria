import { bob, type ChatRow, type Snapshot } from '@spyria/db'
import { chatId, type MemberId, memberId, projectId, workspaceId } from '@spyria/kernel'
import type { Chat } from './chat.ts'
import { Name } from './name.ts'
import type { Project } from './project.ts'

export const acme = workspaceId('acme')
export const globex = workspaceId('globex')

export const projectIn = (workspace: typeof acme): Project => ({
  id: projectId(`project-${workspace}`),
  workspaceId: workspace,
  name: Name('Billing'),
  archived: false,
})

export const chatInAcme: Chat = {
  id: chatId('chat'),
  workspaceId: acme,
  projectId: projectId('project-acme'),
  type: 'runtime',
  visibility: 'private',
  name: Name('Invoice bug'),
  ownerId: memberId('alice'),
  archived: false,
  model: 'openai/gpt-5',
  reasoningEffort: 'medium',
  mode: null,
  gitBranch: 'main',
  repository: null,
  baseBranch: null,
  originChatId: null,
}

export const withChat = (
  snapshot: Snapshot,
  {
    name,
    visibility,
    type = 'channel',
    participantIds = [],
  }: { name: string; visibility: ChatRow['visibility']; type?: ChatRow['type']; participantIds?: MemberId[] },
): Snapshot => {
  const welcome = snapshot.chats.find((chat) => chat.name === 'Welcome') as ChatRow
  const id = chatId(`chat-${name.toLowerCase()}`)
  return {
    ...snapshot,
    chats: [...snapshot.chats, { ...welcome, id, name, type, visibility, ownerId: bob, projectId: null }],
    chatMembers: [
      ...snapshot.chatMembers,
      { workspaceId: welcome.workspaceId, chatId: id, memberId: bob, roleId: 'owner' },
      ...participantIds.map((memberId) => ({
        workspaceId: welcome.workspaceId,
        chatId: id,
        memberId,
        roleId: 'prompter',
      })),
    ],
  }
}
