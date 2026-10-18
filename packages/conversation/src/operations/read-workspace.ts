import { type ChatPermission, type MemberId, requireChatPermission } from '@hq/kernel'
import type { AgentChat } from '../contracts/agent.ts'
import { agentWorkspacePathOf, snapshotReadingOf, type WorkspaceRead } from '../domain/workspace-reads.ts'
import type { AgentDependencies } from './agent-turn.ts'

type Dependencies = Pick<AgentDependencies, 'transactor' | 'runtimes' | 'agentClient'>
type Input = { chat: AgentChat; memberId: MemberId }

const permittedChat = ({ transactor }: Dependencies, { chat, memberId }: Input, permission: ChatPermission) =>
  transactor.run(async ({ chats }) => {
    await requireChatPermission(chats, chat.chatId, memberId, permission)
    return chats.get(chat.chatId)
  })

const liveReadingOf = async ({ runtimes, agentClient }: Dependencies, chat: AgentChat, path: string) => {
  const endpoint = await runtimes.endpointOf(chat)
  return endpoint && agentClient.readWorkspace(endpoint, path).catch(() => undefined)
}

export const readWorkspace = async (
  dependencies: Dependencies,
  input: Input & { read: WorkspaceRead; path: string },
) => {
  const { type, baseBranch } = await permittedChat(dependencies, input, 'chat.read')
  const { chat, read, path } = input
  if (type !== 'runtime' || (read === 'changes' && !baseBranch)) return { isLive: false }
  const reading = await liveReadingOf(dependencies, chat, agentWorkspacePathOf(read, path, baseBranch ?? ''))
  if (reading) return { isLive: true, ...reading }
  return { isLive: false, ...snapshotReadingOf(await dependencies.runtimes.snapshotOf(chat), read, path) }
}

export const snapshotWorkspace = async (dependencies: Dependencies, chat: AgentChat) => {
  const { baseBranch } = await dependencies.transactor.run(({ chats }) => chats.get(chat.chatId))
  const [tree, changes] = await Promise.all([
    liveReadingOf(dependencies, chat, agentWorkspacePathOf('tree', '', '')),
    baseBranch ? liveReadingOf(dependencies, chat, agentWorkspacePathOf('changes', '', baseBranch)) : undefined,
  ])
  if (tree) await dependencies.runtimes.keepSnapshot(chat, JSON.stringify({ tree, changes }))
}

export const wakeWorkspace = async (dependencies: Dependencies, input: Input) => {
  const { type, localSession } = await permittedChat(dependencies, input, 'chat.post')
  if (type === 'runtime' && localSession !== null) await dependencies.runtimes.ensureRunning(input.chat)
}
