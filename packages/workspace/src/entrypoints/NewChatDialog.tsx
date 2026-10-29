import { type ChatVisibility, type ProjectId, projectId, type WorkspaceId } from '@spyria/kernel'
import {
  buttonClass,
  Dialog,
  ErrorMessage,
  fieldClass,
  labelClass,
  SegmentedChoice,
  useGuardedAction,
} from '@spyria/ui'
import { type ReactNode, type SubmitEvent, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { GitHubNotConfigured } from '../domain/errors.ts'
import type { GitHubRepository } from '../domain/github.ts'
import { Name } from '../domain/name.ts'
import type { Sidebar } from '../queries/get-sidebar.ts'
import { useWorkspaceCommands } from './providers.tsx'
import { useWorkspacePermissions } from './useWorkspacePermissions.ts'

type Audience = 'members' | 'ai'

const Question = <Answer extends string>({
  question,
  name,
  answers,
  value,
  disabledAnswers,
  onAnswer,
  children,
}: {
  question: string
  name: string
  answers: Record<Answer, string>
  value: Answer | null
  disabledAnswers?: readonly Answer[]
  onAnswer: (answer: Answer) => void
  children?: ReactNode
}) => (
  <div className="flex flex-col gap-1">
    <p aria-hidden className="text-sm text-muted">
      {question}
    </p>
    <SegmentedChoice
      label={question}
      name={name}
      options={Object.keys(answers) as Answer[]}
      labels={answers}
      value={value}
      disabledOptions={disabledAnswers}
      onChange={onAnswer}
    />
    {children}
  </div>
)

export const NewChatDialog = ({
  workspaceId,
  projects,
  initialProjectId = null,
  onClose,
}: {
  workspaceId: WorkspaceId
  projects: Sidebar['projects']
  initialProjectId?: ProjectId | null
  onClose: () => void
}) => {
  const commands = useWorkspaceCommands()
  const navigate = useNavigate()
  const [visibility, setVisibility] = useState<ChatVisibility | null>(null)
  const [audience, setAudience] = useState<Audience | null>(null)
  const [needsGitHub, setNeedsGitHub] = useState<'yes' | 'no' | null>(null)
  const [draftName, setDraftName] = useState('')
  const [selectedProjectId, setSelectedProjectId] = useState(initialProjectId)
  const [repositories, setRepositories] = useState<GitHubRepository[]>()
  const [repository, setRepository] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [baseBranch, setBaseBranch] = useState('')
  const { errorMessage, isPending, run } = useGuardedAction()
  const isAiChat = audience === 'ai'
  const isDev = isAiChat && needsGitHub === 'yes'
  const isAnswered = visibility !== null && audience !== null && (!isAiChat || needsGitHub !== null)
  const chooseVisibility = (chosen: ChatVisibility) => {
    setVisibility(chosen)
    if (chosen === 'public' && isAiChat) setAudience(null)
  }
  const canConnectGitHub = useWorkspacePermissions(workspaceId).includes('github.manage')
  const [loadFailure, setLoadFailure] = useState<string | null>(null)
  const [isGitHubMissing, setIsGitHubMissing] = useState(false)
  useEffect(() => {
    if (isDev && !repositories)
      commands.listRepositories({ workspaceId }).then(setRepositories, (error: Error) => {
        setRepositories([])
        if (error instanceof GitHubNotConfigured) setIsGitHubMissing(true)
        else setLoadFailure(error.message)
      })
  }, [commands, workspaceId, isDev, repositories])
  useEffect(() => {
    setBranches([])
    if (!repository) return
    commands.listBranches({ workspaceId, repository }).then(
      (listed) => {
        setBranches(listed)
        setBaseBranch(repositories?.find(({ fullName }) => fullName === repository)?.defaultBranch ?? listed[0] ?? '')
      },
      (error: Error) => setLoadFailure(error.message),
    )
  }, [commands, workspaceId, repository, repositories])
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const created = async () =>
      isDev
        ? commands.createDevChat({
            workspaceId,
            name: Name(draftName),
            projectId: selectedProjectId,
            repository,
            baseBranch,
          })
        : commands.createChat({
            workspaceId,
            type: isAiChat ? 'runtime' : 'channel',
            ...(!isAiChat && visibility && { visibility }),
            name: Name(draftName),
            projectId: selectedProjectId,
          })
    await run(async () => {
      const chatId = await created()
      onClose()
      navigate(`/w/${workspaceId}/chats/${chatId}`)
    })
  }
  return (
    <Dialog label="New chat" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Question
          question="Is it public, so everyone in the workspace can join?"
          name="visibility"
          answers={{ public: 'Yes', private: 'No' }}
          value={visibility}
          onAnswer={chooseVisibility}
        />
        <Question
          question="Is it for members messaging each other, or an AI chat?"
          name="audience"
          answers={{ members: 'Members messaging', ai: 'AI chat' }}
          value={audience}
          disabledAnswers={visibility === 'public' ? ['ai'] : []}
          onAnswer={setAudience}
        >
          {visibility === 'public' && <p className="text-xs text-muted">AI chats are always private.</p>}
        </Question>
        {isAiChat && (
          <Question
            question="Does it need GitHub access?"
            name="github"
            answers={{ yes: 'Yes', no: 'No' }}
            value={needsGitHub}
            onAnswer={setNeedsGitHub}
          />
        )}
        {isDev && isGitHubMissing && (
          <p className="text-sm text-muted">
            {canConnectGitHub ? (
              <Link to={`/w/${workspaceId}/settings/github`} onClick={onClose} className="text-ink underline">
                Connect GitHub in Workspace settings
              </Link>
            ) : (
              'Connect GitHub in Workspace settings'
            )}
          </p>
        )}
        {isDev && !isGitHubMissing && (
          <>
            <label className={labelClass}>
              Repository
              <select className={fieldClass} value={repository} onChange={(event) => setRepository(event.target.value)}>
                <option value="">{repositories ? 'Choose a repository' : 'Loading…'}</option>
                {repositories?.map(({ fullName }) => (
                  <option key={fullName} value={fullName}>
                    {fullName}
                  </option>
                ))}
              </select>
            </label>
            <label className={labelClass}>
              Base branch
              <select
                className={fieldClass}
                value={baseBranch}
                disabled={branches.length === 0}
                onChange={(event) => setBaseBranch(event.target.value)}
              >
                {branches.map((branch) => (
                  <option key={branch} value={branch}>
                    {branch}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <label className={labelClass}>
          Chat name
          <input className={fieldClass} value={draftName} onChange={(event) => setDraftName(event.target.value)} />
        </label>
        <label className={labelClass}>
          Project
          <select
            className={fieldClass}
            value={selectedProjectId ?? ''}
            onChange={(event) => setSelectedProjectId(event.target.value ? projectId(event.target.value) : null)}
          >
            <option value="">No project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <ErrorMessage message={errorMessage ?? loadFailure} />
        <button
          type="submit"
          className={buttonClass}
          disabled={!isAnswered || draftName.trim() === '' || isPending || (isDev && (!repository || !baseBranch))}
        >
          Confirm
        </button>
      </form>
    </Dialog>
  )
}
