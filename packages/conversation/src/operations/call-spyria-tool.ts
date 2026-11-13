import type { MemberId } from '@spyria/kernel'
import type { AgentChat } from '../contracts/agent.ts'
import { openedPageOf, openPageTool, pageOpenedText } from '../domain/browser-pages.ts'
import { asleepRefusal } from '../domain/git-actions.ts'
import {
  authorIdsOf,
  listPublicChatsTool,
  noPublicChatRefusal,
  publicChatFilterOf,
  publicChatHitsListed,
  publicChatHitsOf,
  publicChatListOf,
  publicChatMessagesFetched,
  publicChatReadingOf,
  publicChatSearchOf,
  publicChatTranscriptOf,
  readPublicChatTool,
  searchPublicChatsTool,
} from '../domain/public-chats.ts'
import { screenshotRequestOf, screenshotTakenText, takeScreenshotTool } from '../domain/screenshots.ts'
import type { AgentDependencies } from './agent-turn.ts'

type Dependencies = Pick<AgentDependencies, 'transactor' | 'runtimes' | 'agentClient'>
type Input = { chat: AgentChat; memberId: MemberId; name: string; input: unknown }
type ToolAnswer = { isRefused: boolean; text: string }

const refused = (text: string): ToolAnswer => ({ isRefused: true, text })
const answered = (text: string): ToolAnswer => ({ isRefused: false, text })
const notAMember = 'The member who prompted is no longer in this workspace'

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

const listPublicChats = async ({ transactor }: Dependencies, { memberId, input }: Input) => {
  const filter = publicChatFilterOf(input)
  if ('refusal' in filter) return refused(filter.refusal)
  return transactor.run(async ({ members, publicChats }) => {
    if (!(await members.isMember(memberId))) return refused(notAMember)
    return answered(publicChatListOf(await publicChats.chats(), filter))
  })
}

const searchPublicChats = async ({ transactor }: Dependencies, { memberId, input }: Input) => {
  const search = publicChatSearchOf(input)
  if ('refusal' in search) return refused(search.refusal)
  return transactor.run(async ({ members, publicChats }) => {
    if (!(await members.isMember(memberId))) return refused(notAMember)
    const chats = await publicChats.chats()
    if (search.chatId && !chats.some(({ id }) => id === search.chatId)) return refused(noPublicChatRefusal)
    const hits = await publicChats.search(search, publicChatHitsListed)
    const memberName = await members.displayNamesOf(authorIdsOf(hits))
    return answered(publicChatHitsOf(hits, chats, search.needle, memberName))
  })
}

const readPublicChat = async ({ transactor }: Dependencies, { memberId, input }: Input) => {
  const reading = publicChatReadingOf(input)
  if ('refusal' in reading) return refused(reading.refusal)
  return transactor.run(async ({ members, publicChats }) => {
    if (!(await members.isMember(memberId))) return refused(notAMember)
    const chat = (await publicChats.chats()).find(({ id }) => id === reading.chatId)
    if (!chat) return refused(noPublicChatRefusal)
    const messages = await publicChats.messages(reading, publicChatMessagesFetched)
    if (!messages) return refused('No message of this chat has the id given in before')
    const memberName = await members.displayNamesOf(authorIdsOf(messages))
    return answered(publicChatTranscriptOf(chat, messages, reading, memberName))
  })
}

const toolCalls: Record<string, (dependencies: Dependencies, input: Input) => Promise<ToolAnswer>> = {
  [openPageTool.name]: openPage,
  [takeScreenshotTool.name]: takeScreenshot,
  [listPublicChatsTool.name]: listPublicChats,
  [searchPublicChatsTool.name]: searchPublicChats,
  [readPublicChatTool.name]: readPublicChat,
}

export const callSpyriaTool = async (dependencies: Dependencies, input: Input) => {
  const call = toolCalls[input.name]
  return call ? call(dependencies, input) : refused('Unknown tool')
}
