import { type MemberId, requireChatPermission } from '@spyria/kernel'
import type { AgentChat } from '../contracts/agent.ts'
import { BrowserUnavailable } from '../domain/errors.ts'
import type { AgentDependencies } from './agent-turn.ts'
import { type BrowserViewer, watchBrowser } from './browser-sessions.ts'

type Dependencies = Pick<AgentDependencies, 'transactor' | 'runtimes'>
type Input = { chat: AgentChat; memberId: MemberId; viewer: BrowserViewer }

export const watchMemberBrowser = async (dependencies: Dependencies, { chat, memberId, viewer }: Input) => {
  const { type, settings } = await dependencies.transactor.run(async ({ chats, browser }) => {
    await requireChatPermission(chats, chat.chatId, memberId, 'chat.post')
    return { type: (await chats.get(chat.chatId)).type, settings: await browser.settings() }
  })
  if (type !== 'runtime') throw new BrowserUnavailable('Only AI chats with a runtime have a browser')
  if (!settings.forAgents && !settings.forMembers)
    throw new BrowserUnavailable('The browser is turned off in this workspace')
  return watchBrowser(dependencies, { chat, memberId, viewer, canBrowse: settings.forMembers })
}
