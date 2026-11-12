import {
  type ChatId,
  can,
  githubToolApprovalOf,
  githubToolsOf,
  isReadOnlyGitHubTool,
  type MemberId,
  toolApprovals,
} from '@spyria/kernel'
import type { AgentChat } from '../contracts/agent.ts'
import type { ConversationTransactor, UnitOfWork } from '../contracts/transactor.ts'
import { isFrozen } from '../domain/message.ts'

type Dependencies = { transactor: ConversationTransactor }

const githubAccessInChatOf = async (
  { chats, toolCalls }: Pick<UnitOfWork, 'chats' | 'toolCalls'>,
  chatId: ChatId,
  memberId: MemberId,
) => {
  const chat = await chats.get(chatId)
  const mayUse =
    chat.baseBranch !== null && !isFrozen(chat) && can(await chats.permissions(chatId, memberId), 'chat.post')
  const { holder, accessRows, approvals } = await toolCalls.githubAccessOf(memberId)
  return { tools: mayUse && holder ? githubToolsOf(accessRows, holder) : [], approvals }
}

export const githubToolsInChatOf = async (
  unitOfWork: Pick<UnitOfWork, 'chats' | 'toolCalls'>,
  chatId: ChatId,
  memberId: MemberId,
) => (await githubAccessInChatOf(unitOfWork, chatId, memberId)).tools

export const readGitHubToolsInChat = (
  { transactor }: Dependencies,
  { chat, memberId }: { chat: AgentChat; memberId: MemberId },
) => transactor.run((unitOfWork) => githubToolsInChatOf(unitOfWork, chat.chatId, memberId))

export const githubToolPolicy = (
  { transactor }: Dependencies,
  { chat, memberId, toolName }: { chat: AgentChat; memberId: MemberId; toolName: string },
) =>
  transactor.run(async (unitOfWork) => {
    const { tools, approvals } = await githubAccessInChatOf(unitOfWork, chat.chatId, memberId)
    return {
      access: tools.includes(toolName) ? ('allowed' as const) : ('not_granted' as const),
      readOnly: isReadOnlyGitHubTool(toolName),
      approval: githubToolApprovalOf(toolName, approvals) ?? toolApprovals.never,
      answerer: 'prompter' as const,
    }
  })
