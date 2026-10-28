import { Provider } from '@radix-ui/react-tooltip'
import { useChatMessages, useQuery } from '@spyria/db/react'
import { type ChatId, type MessageId, chatId as toChatId, type WorkspaceId } from '@spyria/kernel'
import { useSession } from '@spyria/session'
import {
  buttonClass,
  chatTypeIconOf,
  ErrorMessage,
  focusRing,
  IconButton,
  SegmentedChoice,
  useGuardedAction,
  useShortcut,
} from '@spyria/ui'
import { Folder, GitBranch, TextSearch } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate, useOutletContext, useParams } from 'react-router'
import { ChatFrozen } from '../domain/errors.ts'
import { runsOnNames, runsOnWaitingNoticeOf } from '../domain/session-routing.ts'
import { getConversation } from '../queries/get-conversation.ts'
import { getMentionableNames } from '../queries/get-mentionable-names.ts'
import { Composer } from './Composer.tsx'
import { ContextChip } from './ContextChip.tsx'
import type { QuestionAnswer } from './endpoints.ts'
import { FindBar } from './FindBar.tsx'
import { ForkButton } from './ForkButton.tsx'
import { MessageList } from './MessageList.tsx'
import {
  ChatMediaContext,
  ChatNameContext,
  MentionNamesContext,
  QuestionAnswererContext,
  ToolsAwaitingApprovalContext,
  useConversationCommands,
} from './providers.tsx'
import { RunsOnChip, SessionChip } from './SessionChip.tsx'
import { type FindRequest, findRequestKey, useFindInChat } from './useFindInChat.ts'
import { useLiveMessages, withLiveMessages } from './useLiveMessages.ts'

const frozenNotice = new ChatFrozen().message
type FindState = Readonly<{ chatId: ChatId; text: string; messageId: MessageId | null; openings: number }>

const findRequestOf = (state: unknown) =>
  (state as Partial<Record<typeof findRequestKey, FindRequest>> | null)?.[findRequestKey]

const useFindState = (chatId: ChatId) => {
  const location = useLocation()
  const request = findRequestOf(location.state)
  const [find, setFind] = useState<FindState | null>(null)
  const [appliedLocationKey, setAppliedLocationKey] = useState<string | null>(null)
  if (request && appliedLocationKey !== location.key) {
    setAppliedLocationKey(location.key)
    setFind({ chatId, text: request.text, messageId: request.messageId, openings: (find?.openings ?? 0) + 1 })
  }
  const shown = find?.chatId === chatId ? find : null
  return {
    find: shown,
    open: () => setFind({ chatId, text: shown?.text ?? '', messageId: null, openings: (find?.openings ?? 0) + 1 }),
    changeText: (text: string) => setFind(shown && { ...shown, text, messageId: null }),
    close: () => setFind(null),
  }
}

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
  runtimeStatus: (access: { canRetry: boolean; canManage: boolean; isAgentWorking: boolean }) => ReactNode
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
  const findState = useFindState(chatId)
  const [messagesElement, setMessagesElement] = useState<HTMLElement | null>(null)
  const findTargetId = findState.find?.messageId ?? null
  const find = useFindInChat(messagesElement, findState.find?.text ?? '', findTargetId)
  useShortcut('f', 'Find in this chat', findState.open)
  const mentionNames = useQuery(getMentionableNames, workspaceId)
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
  const isFindTargetMissing = findTargetId !== null && !live.messages.some((message) => message.id === findTargetId)
  const loadEarlierTowardsTarget =
    isFindTargetMissing && chatMessages.isComplete && chatMessages.hasEarlier ? chatMessages.loadEarlier : undefined
  useEffect(() => loadEarlierTowardsTarget?.(), [loadEarlierTowardsTarget])
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
  const status = runtimeStatus({
    canRetry: conversation.canPost,
    canManage: conversation.canConfigure,
    isAgentWorking: conversation.isAgentWorking,
  })
  const branch = live.workspace?.branch ?? conversation.gitBranch
  const { Icon: ChatTypeIcon, label: chatTypeLabel } = chatTypeIconOf(conversation.type)
  return (
    <div key={chatId} className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-4 px-4 py-6">
      <Provider delayDuration={300}>
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
                  <span className="min-w-0 truncate text-sm text-muted">
                    Agent acts as <strong className="font-semibold text-ink">{conversation.ownerName}</strong>
                  </span>
                  <ForkButton onFork={fork} />
                </>
              )}
              <IconButton label="Find in this chat" shortcut="f" icon={TextSearch} onClick={findState.open} />
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
        {findState.find && (
          <FindBar
            key={findState.find.openings}
            text={findState.find.text}
            count={find.count}
            position={find.position}
            onTextChange={findState.changeText}
            onNext={find.next}
            onPrevious={find.previous}
            onSearchEarlier={chatMessages.isComplete && chatMessages.hasEarlier ? chatMessages.loadEarlier : undefined}
            onClose={findState.close}
          />
        )}
      </Provider>
      <QuestionAnswererContext
        value={{ answer: answerQuestion, mayAnswerAsPrompter: mayPrompt, isOwner: conversation.isOwner }}
      >
        <ToolsAwaitingApprovalContext value={toolsAwaitingApproval}>
          <ChatMediaContext value={{ chatId, isRuntime: conversation.type === 'runtime' }}>
            <MentionNamesContext value={mentionNames}>
              <ChatNameContext value={conversation.title}>
                <div ref={setMessagesElement} className="flex min-h-0 flex-1 flex-col">
                  <MessageList
                    conversation={conversation}
                    items={withLiveMessages(conversation.items, live)}
                    isComplete={chatMessages.isComplete}
                    onLoadEarlier={
                      chatMessages.isComplete && chatMessages.hasEarlier ? chatMessages.loadEarlier : undefined
                    }
                    onStop={conversation.canConfigure ? () => commands.stopAgent({ workspaceId, chatId }) : undefined}
                    onFork={conversation.isOwner ? undefined : fork}
                  />
                </div>
              </ChatNameContext>
            </MentionNamesContext>
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
                  isAgentWorking={conversation.isAgentWorking}
                  isOwner={conversation.isOwner}
                  canConfigure={conversation.canConfigure}
                  contextTokens={conversation.context?.tokens ?? null}
                />
                {conversation.context && <ContextChip context={conversation.context} />}
              </>
            )
          }
        />
      )}
    </div>
  )
}
