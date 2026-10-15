import { useStore } from '@hq/db/react'
import { type ChatId, messageId, type WorkspaceId } from '@hq/kernel'
import { useEffect, useState } from 'react'
import {
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

export const withLiveMessages = (
  items: readonly ConversationItem[],
  liveMessages: readonly ConversationMessage[],
): readonly ConversationItem[] => {
  const isPlanSwitch = isPlanSwitchIn(liveMessages)
  return liveMessages.reduce(
    withLiveMessage,
    items.filter((item) => item.type === 'fold' || !isPlanSwitch(item.message)),
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
  isOwn: false,
  isDeleted: false,
  isEdited: false,
  isRunning: true,
  canConnectTools: false,
})

type LiveState = { chatKey: string; reply: StreamedReply; questions: readonly QuestionFrame[] }
type Frame = Parameters<Parameters<AgentStream['subscribe']>[2]>[0]

const liveAfter = (
  current: LiveState,
  chatKey: string,
  frame: Frame,
  replyCountOf: (promptId: string) => number,
): LiveState => {
  const { reply, questions } = current.chatKey === chatKey ? current : { reply: null, questions: [] }
  if ('question' in frame)
    return {
      chatKey,
      reply,
      questions: [...questions.filter(({ question }) => question.questionId !== frame.question.questionId), frame],
    }
  return {
    chatKey,
    questions,
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
): readonly ConversationMessage[] => {
  const agentStream = useAgentStream()
  const store = useStore()
  const chatKey = `${workspaceId}/${chatId}`
  const [live, setLive] = useState<LiveState>({ chatKey, reply: null, questions: [] })
  useEffect(
    () =>
      agentStream.subscribe(workspaceId, chatId, (frame) => {
        const replyCountOf = replyCountIn(store.read().messages)
        setLive((current) => liveAfter(current, chatKey, frame, replyCountOf))
      }),
    [agentStream, store, workspaceId, chatId, chatKey],
  )
  return liveMessagesOf(live.chatKey === chatKey ? live : { chatKey, reply: null, questions: [] }, messages)
}
