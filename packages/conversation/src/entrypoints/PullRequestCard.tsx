import { chatId, type WorkspaceId } from '@spyria/kernel'
import { focusRing, ghostButtonClass } from '@spyria/ui'
import { GitPullRequest } from 'lucide-react'
import { use, useState } from 'react'
import { useOutletContext, useParams } from 'react-router'
import { checksOf, type PullRequestStep, reviewPromptOf, unresolvedCommentsOf } from '../domain/pull-requests.ts'
import { QuestionAnswererContext, useConversationCommands } from './providers.tsx'

const reviewLabels = { approved: 'Approved', changes_requested: 'Changes requested', commented: 'Commented' }
const stateClasses: Record<PullRequestStep['state'], string> = {
  open: 'bg-added text-ink',
  draft: 'bg-hover text-muted',
  merged: 'bg-accent text-accent-ink',
  closed: 'bg-removed text-ink',
}

const PullRequestCard = ({ step }: { step: PullRequestStep }) => {
  const workspaceId = useOutletContext<WorkspaceId>()
  const currentChatId = chatId(useParams().chatId ?? '')
  const commands = useConversationCommands()
  const { isOwner } = use(QuestionAnswererContext)
  const [isAddressing, setIsAddressing] = useState(false)
  const comments = unresolvedCommentsOf(step)
  const address = () => {
    setIsAddressing(true)
    commands
      .sendMessage({ workspaceId, chatId: currentChatId, text: reviewPromptOf(step) })
      .catch(console.error)
      .finally(() => setIsAddressing(false))
  }
  return (
    <section
      aria-label={`Pull request #${step.number}`}
      className="flex flex-col gap-2 rounded-lg border border-line bg-raised p-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <GitPullRequest aria-hidden size={16} className="shrink-0 text-muted" />
        <a href={step.url} target="_blank" rel="noreferrer" className={`font-medium underline ${focusRing}`}>
          {step.title}
        </a>
        <span className="text-muted">#{step.number}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs ${stateClasses[step.state]}`}>{step.state}</span>
      </div>
      <p className="text-xs text-muted">
        Checks {checksOf(step)}
        {step.review && ` · ${reviewLabels[step.review]}`} · {step.commits} {step.commits === 1 ? 'commit' : 'commits'}
      </p>
      {comments.length > 0 && (
        <ul aria-label="Review comments" className="flex flex-col gap-1 border-l-2 border-line pl-2 text-xs">
          {comments.map((comment) => (
            <li key={comment.id}>
              <span className="font-mono">
                {comment.path}
                {comment.line !== null && `:${comment.line}`}
              </span>{' '}
              <span className="text-muted">{comment.author}:</span> {comment.body}
            </li>
          ))}
        </ul>
      )}
      {isOwner && comments.length > 0 && step.state !== 'merged' && step.state !== 'closed' && (
        <button type="button" disabled={isAddressing} onClick={address} className={`self-start ${ghostButtonClass}`}>
          Address review comments
        </button>
      )}
    </section>
  )
}

export default PullRequestCard
