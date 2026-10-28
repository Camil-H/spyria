import type { AgentChat } from '../contracts/agent.ts'
import { openedPageOf, pageOpenedText } from '../domain/browser-pages.ts'
import type { AgentDependencies } from './agent-turn.ts'

type Dependencies = Pick<AgentDependencies, 'transactor'>
type Input = { chat: AgentChat; name: string; input: unknown }
type ToolAnswer = { isRefused: boolean; text: string }

const openPage = async ({ transactor }: Dependencies, { chat, input }: Input): Promise<ToolAnswer> => {
  const page = openedPageOf(input)
  if ('refusal' in page) return { isRefused: true, text: page.refusal }
  await transactor.run(({ browserPages }) => browserPages.open(chat.chatId, page, new Date()))
  return { isRefused: false, text: pageOpenedText }
}

export const callSpyriaTool = (dependencies: Dependencies, input: Input) => openPage(dependencies, input)
