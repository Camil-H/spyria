import type { MemberId, MessageId } from '@spyria/kernel'
import type { AgentChat } from '../contracts/agent.ts'
import type { ToolCallDecision } from '../contracts/repositories.ts'
import { isWebPage, openedPageOf, openPageTool, pageOpenedText } from '../domain/browser-pages.ts'
import {
  type BrowserCommand,
  browserCommandOf,
  browserTurnedOffForAgents,
  isBrowserTool,
  openCommandOf,
  submitCheckOf,
} from '../domain/browser-tools.ts'
import { BrowserUnavailable } from '../domain/errors.ts'
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
import { checkBrowserCommand, runBrowserCommand } from './browser-sessions.ts'
import { requestToolApproval } from './request-tool-approval.ts'

type Dependencies = Pick<
  AgentDependencies,
  'transactor' | 'runtimes' | 'agentClient' | 'eventSockets' | 'approvalWindowMilliseconds'
>
type Input = { chat: AgentChat; memberId: MemberId; promptId: MessageId | null; name: string; input: unknown }
type Decision = { decision: ToolCallDecision; decidedBy: MemberId | null }
type ToolAnswer = { isRefused: boolean; text: string; image?: string } & Partial<Decision>

const refused = (text: string, decision?: Decision): ToolAnswer => ({ isRefused: true, text, ...decision })
const answered = (text: string): ToolAnswer => ({ isRefused: false, text })
const notApprovedText = (memberName: string) => `${memberName} did not approve this step in their browser`

const inBrowser = async (
  dependencies: Dependencies,
  { chat, memberId }: Input,
  command: BrowserCommand,
  decision?: Decision,
): Promise<ToolAnswer> => {
  const settings = await dependencies.transactor.run(({ browser }) => browser.settings())
  if (!settings.forAgents) return refused(browserTurnedOffForAgents)
  try {
    const answer = await runBrowserCommand(dependencies, { chat, memberId, command })
    return { isRefused: false, ...answer, ...decision }
  } catch (error) {
    if (error instanceof BrowserUnavailable) return refused(error.message, decision)
    throw error
  }
}

const submitApproval = async (dependencies: Dependencies, input: Input, command: BrowserCommand) => {
  const settings = await dependencies.transactor.run(({ browser }) => browser.settings())
  const check = submitCheckOf(command)
  if (!settings.forAgents || !settings.approveSubmits || check === 'never') return undefined
  const isSubmitting =
    check === 'always' ||
    (await checkBrowserCommand(dependencies, { ...input, command: check }).catch((error) => {
      if (error instanceof BrowserUnavailable) return false
      throw error
    }))
  if (!isSubmitting) return undefined
  const memberName = await dependencies.transactor.run(({ members }) => members.displayNameOf(input.memberId))
  const decided = await requestToolApproval(dependencies, {
    chat: input.chat,
    promptId: input.promptId,
    answererId: input.memberId,
    approval: {
      server: 'Spyria',
      tool: input.name,
      arguments: JSON.stringify(input.input ?? {}),
      prompterName: memberName,
      answererId: input.memberId,
      answererName: memberName,
    },
  })
  return { ...decided, memberName }
}

const driveBrowser = async (dependencies: Dependencies, input: Input) => {
  const parsed = browserCommandOf(input.name, input.input)
  if ('refusal' in parsed) return refused(parsed.refusal)
  const command = parsed.browserCommand
  const approval = await submitApproval(dependencies, input, command)
  if (approval && approval.decision !== 'approved')
    return refused(notApprovedText(approval.memberName), {
      decision: approval.decision,
      decidedBy: approval.decidedBy,
    })
  return inBrowser(
    dependencies,
    input,
    command,
    approval && { decision: approval.decision, decidedBy: approval.decidedBy },
  )
}
const notAMember = 'The member who prompted is no longer in this workspace'

const openPage = async (dependencies: Dependencies, call: Input) => {
  const { transactor } = dependencies
  const { chat, input } = call
  const page = openedPageOf(input)
  if ('refusal' in page) return refused(page.refusal)
  if (isWebPage(page)) return inBrowser(dependencies, call, openCommandOf(page.url))
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

export const callSpyriaTool = async (dependencies: Dependencies, input: Input): Promise<ToolAnswer> => {
  if (isBrowserTool(input.name)) return driveBrowser(dependencies, input)
  const call = toolCalls[input.name]
  return call ? call(dependencies, input) : refused('Unknown tool')
}
