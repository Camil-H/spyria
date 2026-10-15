import { useQuery } from '@hq/db/react'
import { type ChatId, chatId as toChatId, type WorkspaceId } from '@hq/kernel'
import { useSession } from '@hq/session'
import { Bot, Folder, GitBranch, Hash } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { Link, Navigate, useOutletContext, useParams } from 'react-router'
import { runsOnNames, runsOnWaitingNoticeOf } from '../domain/session-routing.ts'
import { getConversation } from '../queries/get-conversation.ts'
import { Composer } from './Composer.tsx'
import { MessageList } from './MessageList.tsx'
import { AnswerQuestionContext, useConversationCommands } from './providers.tsx'
import { PlanModeToggle, RunsOnChip, SessionChip } from './SessionChip.tsx'
import { useLiveMessages, withLiveMessages } from './useLiveMessages.ts'

const workspaceChipClass =
  'flex min-w-0 items-center gap-1.5 rounded-md border border-line bg-raised px-2 py-1 text-xs text-muted'

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
  const live = useLiveMessages(workspaceId, chatId, conversation?.messages ?? [])
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
  const mayPrompt =
    conversation.type === 'runtime' &&
    conversation.runsOn !== null &&
    (conversation.localSession ? conversation.isOwner : canPrompt)
  const branch = live.workspace?.branch ?? conversation.gitBranch
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
              <span className="text-sm text-muted">
                Agent acts as <strong className="font-semibold text-ink">{conversation.ownerName}</strong>
              </span>
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
      <AnswerQuestionContext
        value={
          mayPrompt
            ? (questionId, answer) => commands.answerQuestion({ workspaceId, chatId, questionId, answer })
            : undefined
        }
      >
        <MessageList
          conversation={conversation}
          items={withLiveMessages(conversation.items, live.messages)}
          onStop={() => commands.stopAgent({ workspaceId, chatId })}
        />
      </AnswerQuestionContext>
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
        aboveBox={
          (live.workspace || branch !== null) && (
            <div className="flex min-w-0 gap-2">
              {live.workspace && (
                <span title={live.workspace.cwd} className={workspaceChipClass}>
                  <Folder aria-label="Working directory" role="img" size={12} className="shrink-0" />
                  <span className="truncate">{live.workspace.cwd.split('/').filter(Boolean).at(-1) ?? '/'}</span>
                </span>
              )}
              {branch !== null && (
                <span className={workspaceChipClass}>
                  <GitBranch aria-label="Git branch" role="img" size={12} className="shrink-0" />
                  <span className="truncate">{branch}</span>
                </span>
              )}
            </div>
          )
        }
        bottomBar={
          conversation.type === 'runtime' && (
            <>
              {conversation.runsOn !== null && (
                <RunsOnChip
                  workspaceId={workspaceId}
                  chatId={chatId}
                  runsOn={conversation.runsOn}
                  runsOnChoices={conversation.runsOnChoices}
                />
              )}
              <SessionChip
                workspaceId={workspaceId}
                chatId={chatId}
                model={conversation.model}
                reasoningEffort={conversation.reasoningEffort}
                defaultModel={conversation.defaultModel}
                subagentPolicy={conversation.subagentPolicy}
                harness={conversation.harness}
                localSession={conversation.localSession}
                isOwner={conversation.isOwner}
              />
              {conversation.runsOn !== null && (
                <PlanModeToggle
                  workspaceId={workspaceId}
                  chatId={chatId}
                  isPlanning={conversation.isPlanning}
                  hasSession={live.workspace !== undefined}
                  mayPrompt={mayPrompt}
                />
              )}
              <div className="ml-auto shrink-0">{runtimeStatus}</div>
            </>
          )
        }
      />
    </div>
  )
}
