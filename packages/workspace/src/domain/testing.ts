import { chatId, memberId, projectId, workspaceId } from '@hq/kernel'
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
  name: Name('Invoice bug'),
  ownerId: memberId('alice'),
  archived: false,
  model: 'openai/gpt-5',
  reasoningEffort: 'medium',
  gitBranch: 'main',
  originChatId: null,
}
