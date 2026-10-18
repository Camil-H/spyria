import { useStore } from '@hq/db/react'
import { type ChatId, messageId, type WorkspaceId } from '@hq/kernel'
import { useEffect, useState } from 'react'
import {
  type AgentWorkspace,
  type QuestionFrame,
  type StreamedReply,
  storedStreamedReply,
  streamedReplyAfter,
  visibleStreamedReply,
} from '../domain/streamed-reply.ts'
import { type ConversationItem, type ConversationMessage, isPlanSwitchIn } from '../queries/get-conversation.ts'
import type { AgentStream } from './commands.ts'
import { useAgentStream } from './providers.tsx'

const replyCountIn = (messages: readonly { replyToId: string | null }[]) => (promptId: string) =>
  messages.filter((message) => message.replyToId === promptId).length

const withLiveMessage = (items: readonly ConversationItem[], live: ConversationMessage) => {
  const threadEnd = items.findLastIndex(
    (item) =>
      item.type === 'message' && (item.message.id === live.replyToId || item.message.replyToId === live.replyToId),
  )
  const liveItem = { type: 'message', message: live } as const
  return threadEnd === -1 ? [...items, liveItem] : items.toSpliced(threadEnd + 1, 0, liveItem)
}

const withLiveDelegation =
  (delegated: LiveState['delegated']) =>
  (item: ConversationItem): ConversationItem => {
    const delegation = item.type === 'message' ? item.message.delegation : undefined
    const live = delegation?.status === 'running' && delegated[delegation.id]
    if (item.type !== 'message' || !delegation || !live) return item
    const { text, isReasoning = false } = live
    return { ...item, message: { ...item.message, delegation: { ...delegation, live: { text, isReasoning } } } }
  }

const withLiveCommandOutput =
  (commandOutputs: LiveState['commandOutputs']) =>
  (item: ConversationItem): ConversationItem => {
    const step = item.type === 'message' ? item.message.step : null
    const output = item.type === 'message' ? commandOutputs[item.message.id] : undefined
    if (item.type !== 'message' || step?.type !== 'command' || step.exitCode !== null || output === undefined)
      return item
    return { ...item, message: { ...item.message, step: { ...step, output } } }
  }

export const withLiveMessages = (
  items: readonly ConversationItem[],
  {
    messages: liveMessages,
    delegated,
    commandOutputs,
  }: Pick<LiveState, 'delegated' | 'commandOutputs'> & { messages: readonly ConversationMessage[] },
): readonly ConversationItem[] => {
  const isPlanSwitch = isPlanSwitchIn(liveMessages)
  return liveMessages.reduce(
    withLiveMessage,
    items
      .filter((item) => item.type === 'fold' || !isPlanSwitch(item.message))
      .map(withLiveDelegation(delegated))
      .map(withLiveCommandOutput(commandOutputs)),
  )
}

const liveMessageOf = (
  messages: readonly ConversationMessage[],
  promptId: string,
  fields: Pick<ConversationMessage, 'id' | 'kind' | 'body' | 'step'>,
): ConversationMessage => ({
  ...fields,
  authorName: 'Agent',
  createdAt: messages.find((message) => message.id === promptId)?.createdAt ?? new Date(0).toISOString(),
  replyToId: messageId(promptId),
  canEdit: false,
  isDeleted: false,
  isEdited: false,
  isRunning: true,
  canReply: false,
  runtimes: [],
  thread: null,
})

type LiveState = {
  chatKey: string
  reply: StreamedReply
  questions: readonly QuestionFrame[]
  workspace?: AgentWorkspace
  delegated: Readonly<Record<string, StreamedReply>>
  commandOutputs: Readonly<Record<string, string>>
}
const emptyLiveOf = (chatKey: string): LiveState => ({
  chatKey,
  reply: null,
  questions: [],
  delegated: {},
  commandOutputs: {},
})
type Frame = Parameters<Parameters<AgentStream['subscribe']>[2]>[0]

const liveAfter = (
  current: LiveState,
  chatKey: string,
  frame: Frame,
  replyCountOf: (promptId: string) => number,
): LiveState => {
  const live = current.chatKey === chatKey ? current : emptyLiveOf(chatKey)
  const { reply, questions, delegated } = live
  if ('commandOutput' in frame) {
    const { stepId, output } = frame.commandOutput
    return { ...live, commandOutputs: { ...live.commandOutputs, [stepId]: output } }
  }
  if ('workspace' in frame) {
    const { sessionUpdate: _, ...workspace } = frame.workspace
    return { ...live, workspace }
  }
  if ('question' in frame)
    return {
      ...live,
      questions: [...questions.filter(({ question }) => question.questionId !== frame.question.questionId), frame],
    }
  if ('delegationId' in frame) {
    const { delegationId, text } = frame
    const next =
      text && streamedReplyAfter(delegated[delegationId] ?? null, { ...frame, promptId: delegationId }, () => 0)
    return { ...live, delegated: { ...delegated, [delegationId]: next || null } }
  }
  return {
    ...live,
    reply: 'storedId' in frame ? storedStreamedReply(reply, frame) : streamedReplyAfter(reply, frame, replyCountOf),
  }
}

const liveMessagesOf = ({ reply, questions }: LiveState, messages: readonly ConversationMessage[]) => {
  const visible = visibleStreamedReply(reply, replyCountIn(messages), (storedId) =>
    messages.some((message) => message.id === storedId),
  )
  return [
    ...(visible
      ? [
          liveMessageOf(messages, visible.promptId, {
            id: messageId(`streamed-${visible.promptId}`),
            kind: visible.isReasoning ? 'step' : 'agent',
            body: visible.text,
            step: visible.isReasoning ? { type: 'thought', text: visible.text, durationMilliseconds: null } : null,
          }),
        ]
      : []),
    ...questions
      .filter(
        ({ question }) =>
          !messages.some(
            (message) => message.step?.type === 'question' && message.step.questionId === question.questionId,
          ),
      )
      .map(({ promptId, question: { sessionUpdate: _, ...question } }) =>
        liveMessageOf(messages, promptId, {
          id: messageId(`question-${question.questionId}`),
          kind: 'step',
          body: '',
          step: { type: 'question', ...question },
        }),
      ),
  ]
}

export const useLiveMessages = (
  workspaceId: WorkspaceId,
  chatId: ChatId,
  messages: readonly ConversationMessage[],
): Pick<LiveState, 'delegated' | 'commandOutputs'> & {
  messages: readonly ConversationMessage[]
  workspace?: AgentWorkspace
} => {
  const agentStream = useAgentStream()
  const store = useStore()
  const chatKey = `${workspaceId}/${chatId}`
  const [live, setLive] = useState<LiveState>(emptyLiveOf(chatKey))
  useEffect(
    () =>
      agentStream.subscribe(workspaceId, chatId, (frame) => {
        const replyCountOf = replyCountIn(store.read().messages)
        setLive((current) => liveAfter(current, chatKey, frame, replyCountOf))
      }),
    [agentStream, store, workspaceId, chatId, chatKey],
  )
  const current = live.chatKey === chatKey ? live : emptyLiveOf(chatKey)
  return {
    messages: liveMessagesOf(current, messages),
    workspace: current.workspace,
    delegated: current.delegated,
    commandOutputs: current.commandOutputs,
  }
}
