import { useQuery } from '@hq/db/react'
import { type ChatId, chatId as toChatId, type WorkspaceId } from '@hq/kernel'
import { useSession } from '@hq/session'
import { Bot, GitBranch, Hash } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { Link, Navigate, useOutletContext, useParams } from 'react-router'
import { runsOnNames, runsOnWaitingNoticeOf } from '../domain/session-routing.ts'
import { getConversation } from '../queries/get-conversation.ts'
import { Composer } from './Composer.tsx'
import { MessageList } from './MessageList.tsx'
import { useConversationCommands } from './providers.tsx'
import { SessionChip } from './SessionChip.tsx'
import { useStreamedReply, withStreamedReply } from './useStreamedReply.ts'

const bubbleClassName = 'rounded-full border border-line px-2 py-0.5 text-xs text-muted'

export const ChatView = ({
  headerActions,
  runtimeStatus,
  canPrompt,
  blockedNotice,
}: {
  headerActions: ReactNode
  runtimeStatus: ReactNode
  canPrompt: boolean
  blockedNotice: ReactNode
}) => {
  const workspaceId = useOutletContext<WorkspaceId>()
  const { memberId } = useSession()
  const chatId = toChatId(useParams().chatId ?? '')
  const [hqRuntime, setHqRuntime] = useState<{ chatId: ChatId; isAvailable: boolean }>()
  const conversation = useQuery(
    getConversation(workspaceId, chatId, memberId, hqRuntime?.chatId === chatId ? hqRuntime.isAvailable : undefined),
  )
  const commands = useConversationCommands()
  const isChoosingRunsOn = conversation?.type === 'runtime' && conversation.isOwner && conversation.runsOn === null
  useEffect(() => {
    if (isChoosingRunsOn)
      commands.chatRouting({ workspaceId, chatId }).then(
        ({ hqRuntimeAvailable }) => setHqRuntime({ chatId, isAvailable: hqRuntimeAvailable }),
        () => setHqRuntime({ chatId, isAvailable: true }),
      )
  }, [commands, workspaceId, chatId, isChoosingRunsOn])
  const streamedReply = useStreamedReply(workspaceId, chatId, conversation?.messages ?? [])
  const newestMessageId = conversation?.messages.at(-1)?.id
  useEffect(() => {
    if (newestMessageId) commands.markChatRead({ workspaceId, chatId })
  }, [commands, workspaceId, chatId, newestMessageId])
  const soleChoice =
    conversation?.isOwner && conversation.runsOn === null && conversation.runsOnChoices?.length === 1
      ? conversation.runsOnChoices[0]
      : null
  useEffect(() => {
    if (soleChoice) commands.updateChatRouting({ workspaceId, chatId, runsOn: soleChoice })
  }, [commands, workspaceId, chatId, soleChoice])
  if (!conversation) return <Navigate to={`/w/${workspaceId}`} replace />
  const isRunsOnOpen = conversation.type === 'runtime' && conversation.runsOn === null
  const ChatTypeIcon = conversation.type === 'runtime' ? Bot : Hash
  const chatTypeLabel = conversation.type === 'runtime' ? 'Runtime chat' : 'Channel'
  return (
    <div key={chatId} className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-4 px-4 py-6">
      <header>
        <div className="flex items-center gap-x-3">
          <div className="flex min-w-0 max-w-1/2 shrink-0 items-center gap-2">
            <ChatTypeIcon aria-label={chatTypeLabel} role="img" size={20} className="shrink-0 text-muted" />
            <h1 className="truncate text-2xl font-semibold">{conversation.title}</h1>
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-x-2 whitespace-nowrap">
            {conversation.type === 'runtime' && (
              <>
                <span className="text-sm text-muted">
                  Agent acts as <strong className="font-semibold text-ink">{conversation.ownerName}</strong>
                </span>
                {conversation.gitBranch !== null && (
                  <span className={`${bubbleClassName} inline-flex items-center gap-1`}>
                    <GitBranch aria-label="Git branch" role="img" size={12} />
                    {conversation.gitBranch}
                  </span>
                )}
              </>
            )}
            {headerActions}
          </div>
        </div>
        {conversation.origin && (
          <Link
            to={`/w/${workspaceId}/chats/${conversation.origin.chatId}`}
            className="mt-1 inline-block text-sm text-muted underline"
          >
            Started from {conversation.origin.name}
          </Link>
        )}
      </header>
      <MessageList
        conversation={conversation}
        items={withStreamedReply(conversation.items, streamedReply)}
        onStop={() => commands.stopAgent({ workspaceId, chatId })}
      />
      {conversation.type === 'runtime' && (
        <div className="-mb-2 flex items-center gap-2">
          <SessionChip
            workspaceId={workspaceId}
            chatId={chatId}
            model={conversation.model}
            reasoningEffort={conversation.reasoningEffort}
            defaultModel={conversation.defaultModel}
            subagentPolicy={conversation.subagentPolicy}
            harness={conversation.harness}
            localSession={conversation.localSession}
            runsOn={conversation.runsOn}
            isOwner={conversation.isOwner}
            runsOnChoices={conversation.runsOnChoices}
          />
          {runtimeStatus}
        </div>
      )}
      {isRunsOnOpen && conversation.runsOnChoices && conversation.runsOnChoices.length > 1 && (
        <fieldset aria-label="Runs on" className="flex flex-col gap-2 text-sm">
          <div className="flex gap-1 rounded-lg border border-line bg-app p-1">
            {conversation.runsOnChoices.map((choice) => (
              <label
                key={choice}
                className="relative flex flex-1 cursor-pointer items-center justify-center rounded-md px-3 py-1 text-muted hover:bg-hover hover:text-ink has-focus-visible:outline-2 has-focus-visible:outline-focus"
              >
                <input
                  type="radio"
                  name="runs-on"
                  className="absolute inset-0 cursor-pointer opacity-0"
                  checked={false}
                  onChange={() => commands.updateChatRouting({ workspaceId, chatId, runsOn: choice })}
                />
                {runsOnNames[choice]}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <Composer
        workspaceId={workspaceId}
        chatId={chatId}
        isBlocked={isRunsOnOpen || (conversation.type === 'runtime' && !conversation.localSession && !canPrompt)}
        blockedNotice={
          isRunsOnOpen
            ? conversation.isOwner
              ? 'Choose where this chat runs to send'
              : runsOnWaitingNoticeOf(conversation.ownerName)
            : blockedNotice
        }
      />
    </div>
  )
}
