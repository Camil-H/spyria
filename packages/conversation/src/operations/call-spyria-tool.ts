import type { AgentChat } from '../contracts/agent.ts'
import { openedPageOf, pageOpenedText } from '../domain/browser-pages.ts'
import { asleepRefusal } from '../domain/git-actions.ts'
import { screenshotRequestOf, screenshotTakenText, takeScreenshotTool } from '../domain/screenshots.ts'
import type { AgentDependencies } from './agent-turn.ts'

type Dependencies = Pick<AgentDependencies, 'transactor' | 'runtimes' | 'agentClient'>
type Input = { chat: AgentChat; name: string; input: unknown }
type ToolAnswer = { isRefused: boolean; text: string }

const refused = (text: string): ToolAnswer => ({ isRefused: true, text })
const answered = (text: string): ToolAnswer => ({ isRefused: false, text })

const openPage = async ({ transactor }: Dependencies, { chat, input }: Input) => {
  const page = openedPageOf(input)
  if ('refusal' in page) return refused(page.refusal)
  await transactor.run(({ browserPages }) => browserPages.open(chat.chatId, page, new Date()))
  return answered(pageOpenedText)
}

const takeScreenshot = async ({ runtimes, agentClient }: Dependencies, { chat, input }: Input) => {
  const request = screenshotRequestOf(input)
  if ('refusal' in request) return refused(request.refusal)
  const endpoint = await runtimes.endpointOf(chat)
  if (!endpoint) return refused(asleepRefusal)
  const taken = await agentClient.actOnWorkspace(endpoint, 'screenshot', request)
  if ('failure' in taken) return refused(String(taken.failure))
  return answered(screenshotTakenText(String(taken.path), request.url))
}

export const callSpyriaTool = (dependencies: Dependencies, input: Input) =>
  input.name === takeScreenshotTool.name ? takeScreenshot(dependencies, input) : openPage(dependencies, input)
