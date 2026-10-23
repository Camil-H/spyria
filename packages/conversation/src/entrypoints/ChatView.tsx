import { useChatMessages, useQuery } from '@spyria/db/react'
import { type ChatId, chatId as toChatId, type WorkspaceId } from '@spyria/kernel'
import { useSession } from '@spyria/session'
import { buttonClass, chatTypeIconOf, ErrorMessage, focusRing, SegmentedChoice, useGuardedAction } from '@spyria/ui'
import { Folder, GitBranch } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { Link, Navigate, useNavigate, useOutletContext, useParams } from 'react-router'
import { ChatFrozen } from '../domain/errors.ts'
import { runsOnNames, runsOnWaitingNoticeOf } from '../domain/session-routing.ts'
import { getConversation } from '../queries/get-conversation.ts'
import { Composer } from './Composer.tsx'
import type { QuestionAnswer } from './endpoints.ts'
import { ForkButton } from './ForkButton.tsx'
import { MessageList } from './MessageList.tsx'
import {
  ChatMediaContext,
  QuestionAnswererContext,
  ToolsAwaitingApprovalContext,
  useConversationCommands,
} from './providers.tsx'
import { PlanModeToggle, RunsOnChip, SessionChip } from './SessionChip.tsx'
import { useLiveMessages, withLiveMessages } from './useLiveMessages.ts'

const frozenNotice = new ChatFrozen().message
const workspaceChipClass =
  'flex min-w-0 items-center gap-1.5 rounded-md border border-line bg-raised px-2 py-1 text-xs text-muted'

export const ChatView = ({
  headerActions,
  runtimeStatus,
  hasLlmKey,
  blockedNotice,
  budgetNotice,
  frozenActions,
}: {
  headerActions: ReactNode
  runtimeStatus: (canRetry: boolean) => ReactNode
  hasLlmKey: boolean
  blockedNotice: ReactNode
  budgetNotice: ReactNode
  frozenActions: ReactNode
}) => {
  const workspaceId = useOutletContext<WorkspaceId>()
  const { memberId } = useSession()
  const chatId = toChatId(useParams().chatId ?? '')
  const [spyriaRuntime, setSpyriaRuntime] = useState<{ chatId: ChatId; isAvailable: boolean }>()
  const conversation = useQuery(
    getConversation,
    workspaceId,
    chatId,
    memberId,
    spyriaRuntime?.chatId === chatId ? spyriaRuntime.isAvailable : undefined,
  )
  const chatMessages = useChatMessages(workspaceId, chatId)
  const runsOnChoices =
    conversation?.runsOn === null || (chatMessages.isComplete && !chatMessages.hasEarlier)
      ? (conversation?.runsOnChoices ?? null)
      : null
  const commands = useConversationCommands()
  const navigate = useNavigate()
  const join = useGuardedAction()
  const isChoosingRunsOn = conversation?.type === 'runtime' && conversation.isOwner && conversation.runsOn === null
  useEffect(() => {
    if (isChoosingRunsOn)
      commands.chatRouting({ workspaceId, chatId }).then(
        ({ spyriaRuntimeAvailable }) => setSpyriaRuntime({ chatId, isAvailable: spyriaRuntimeAvailable }),
        () => setSpyriaRuntime({ chatId, isAvailable: true }),
      )
  }, [commands, workspaceId, chatId, isChoosingRunsOn])
  const live = useLiveMessages(workspaceId, chatId, conversation?.messages ?? [])
  const isReadMarkerBehind = conversation?.isReadMarkerBehind === true
  useEffect(() => {
    if (isReadMarkerBehind) commands.markChatRead({ workspaceId, chatId })
  }, [commands, workspaceId, chatId, isReadMarkerBehind])
  const soleChoice =
    conversation?.isOwner && conversation.runsOn === null && runsOnChoices?.length === 1 ? runsOnChoices[0] : null
  useEffect(() => {
    if (soleChoice) commands.updateChatRouting({ workspaceId, chatId, runsOn: soleChoice })
  }, [commands, workspaceId, chatId, soleChoice])
  if (!conversation) return <Navigate to={`/w/${workspaceId}`} replace />
  const isRunsOnOpen = conversation.type === 'runtime' && conversation.runsOn === null
  const mayPrompt =
    conversation.type === 'runtime' &&
    conversation.runsOn !== null &&
    (conversation.localSession ? conversation.isOwner : conversation.canPost && hasLlmKey)
  const answerQuestion = (questionId: string, answer: QuestionAnswer) =>
    commands.answerQuestion({ workspaceId, chatId, questionId, answer })
  const fork = async () =>
    navigate(`/w/${workspaceId}/chats/${await commands.forkChat({ workspaceId, sourceChatId: chatId })}`)
  const toolsAwaitingApproval = new Set(
    live.messages.flatMap(({ step }) =>
      step?.type === 'question' && step.approval ? [`${step.approval.tool} (${step.approval.server})`] : [],
    ),
  )
  const status = runtimeStatus(conversation.canPost)
  const branch = live.workspace?.branch ?? conversation.gitBranch
  const { Icon: ChatTypeIcon, label: chatTypeLabel } = chatTypeIconOf(conversation.type)
  return (
    <div key={chatId} className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-4 px-4 py-6">
      <header>
        <div className="flex items-center gap-x-3">
          <div className="flex min-w-0 max-w-1/2 shrink-0 items-center gap-2">
            <ChatTypeIcon aria-label={chatTypeLabel} role="img" size={20} className="shrink-0 text-muted" />
            <h1 className="truncate text-2xl font-semibold">{conversation.title}</h1>
            {conversation.pullRequest && (
              <a
                href={conversation.pullRequest.url}
                target="_blank"
                rel="noreferrer"
                className={`shrink-0 rounded-full border border-line px-2 py-0.5 text-xs text-ink hover:bg-hover ${focusRing}`}
              >
                PR #{conversation.pullRequest.number} · {conversation.pullRequest.state}
              </a>
            )}
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-x-2 whitespace-nowrap">
            {conversation.type === 'runtime' && (
              <>
                <span className="text-sm text-muted">
                  Agent acts as <strong className="font-semibold text-ink">{conversation.ownerName}</strong>
                </span>
                <ForkButton onFork={fork} />
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
            {conversation.origin.type === 'runtime' ? 'Forked from' : 'Started from'} {conversation.origin.name}
          </Link>
        )}
      </header>
      <QuestionAnswererContext
        value={{ answer: answerQuestion, mayAnswerAsPrompter: mayPrompt, isOwner: conversation.isOwner }}
      >
        <ToolsAwaitingApprovalContext value={toolsAwaitingApproval}>
          <ChatMediaContext value={{ chatId, isRuntime: conversation.type === 'runtime' }}>
            <MessageList
              conversation={conversation}
              items={withLiveMessages(conversation.items, live)}
              isComplete={chatMessages.isComplete}
              onLoadEarlier={chatMessages.isComplete && chatMessages.hasEarlier ? chatMessages.loadEarlier : undefined}
              onStop={conversation.canConfigure ? () => commands.stopAgent({ workspaceId, chatId }) : undefined}
              onFork={conversation.isOwner ? undefined : fork}
            />
          </ChatMediaContext>
        </ToolsAwaitingApprovalContext>
      </QuestionAnswererContext>
      {isRunsOnOpen && runsOnChoices && runsOnChoices.length > 1 && (
        <fieldset aria-label="Runs on">
          <SegmentedChoice
            name="runs-on"
            options={runsOnChoices}
            labels={runsOnNames}
            value={null}
            onChange={(choice) => commands.updateChatRouting({ workspaceId, chatId, runsOn: choice })}
          />
        </fieldset>
      )}
      {conversation.isFrozen ? (
        <div className="flex flex-col items-center gap-2 text-sm">
          <p className="text-muted">{frozenNotice}</p>
          {frozenActions}
        </div>
      ) : conversation.canJoin ? (
        <div className="flex flex-col items-center gap-2">
          <button
            type="button"
            className={buttonClass}
            disabled={join.isPending}
            onClick={() => join.run(() => commands.joinChannel({ workspaceId, chatId }))}
          >
            Join channel
          </button>
          <ErrorMessage message={join.errorMessage} />
        </div>
      ) : (
        <Composer
          workspaceId={workspaceId}
          chatId={chatId}
          isBlocked={
            isRunsOnOpen ||
            !conversation.canPost ||
            (conversation.type === 'runtime' && !conversation.localSession && !hasLlmKey)
          }
          blockedNotice={
            isRunsOnOpen
              ? conversation.isOwner
                ? 'Choose where this chat runs to send'
                : runsOnWaitingNoticeOf(conversation.ownerName)
              : conversation.canPost
                ? blockedNotice
                : 'You can read this chat'
          }
          aboveBox={
            <>
              {conversation.type === 'runtime' && budgetNotice}
              {(live.workspace || branch !== null || conversation.repository !== null) && (
                <div className="flex min-w-0 gap-2">
                  {(live.workspace || conversation.repository !== null) && (
                    <span title={live.workspace?.cwd} className={workspaceChipClass}>
                      <Folder aria-label="Working directory" role="img" size={12} className="shrink-0" />
                      <span className="truncate">
                        {conversation.repository ?? live.workspace?.cwd.split('/').filter(Boolean).at(-1) ?? '/'}
                      </span>
                    </span>
                  )}
                  {branch !== null && (
                    <span className={workspaceChipClass}>
                      <GitBranch aria-label="Git branch" role="img" size={12} className="shrink-0" />
                      <span className="truncate">{branch}</span>
                    </span>
                  )}
                </div>
              )}
            </>
          }
          bottomBar={
            conversation.type === 'runtime' && (
              <>
                {conversation.runsOn !== null ? (
                  <RunsOnChip
                    workspaceId={workspaceId}
                    chatId={chatId}
                    runsOn={conversation.runsOn}
                    runsOnChoices={runsOnChoices}
                    status={status}
                  />
                ) : (
                  status
                )}
                <SessionChip
                  workspaceId={workspaceId}
                  chatId={chatId}
                  model={conversation.model}
                  reasoningEffort={conversation.reasoningEffort}
                  subagentPolicy={conversation.subagentPolicy}
                  harness={conversation.harness}
                  localSession={conversation.localSession}
                  isOwner={conversation.isOwner}
                  canConfigure={conversation.canConfigure}
                />
                {conversation.runsOn !== null && (
                  <PlanModeToggle
                    workspaceId={workspaceId}
                    chatId={chatId}
                    isPlanning={conversation.isPlanning}
                    hasSession={live.workspace !== undefined}
                    mayChange={mayPrompt && conversation.canConfigure}
                  />
                )}
              </>
            )
          }
        />
      )}
    </div>
  )
}
