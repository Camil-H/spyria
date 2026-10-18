import { type ChatVisibility, DomainError, type ProjectId, projectId, type WorkspaceId } from '@hq/kernel'
import { buttonClass, Dialog, ErrorMessage, fieldClass, labelClass, SegmentedChoice, useGuardedAction } from '@hq/ui'
import { type SubmitEvent, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import type { Chat } from '../domain/chat.ts'
import type { GitHubRepository } from '../domain/github.ts'
import { Name } from '../domain/name.ts'
import type { Sidebar } from '../queries/get-sidebar.ts'
import { useWorkspaceCommands } from './providers.tsx'
import { useIsWorkspaceAdmin } from './useIsWorkspaceAdmin.ts'

export const NewChatDialog = ({
  workspaceId,
  projects,
  onClose,
}: {
  workspaceId: WorkspaceId
  projects: Sidebar['projects']
  onClose: () => void
}) => {
  const commands = useWorkspaceCommands()
  const navigate = useNavigate()
  const [type, setType] = useState<Chat['type']>('channel')
  const [visibility, setVisibility] = useState<ChatVisibility>('public')
  const [draftName, setDraftName] = useState('')
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(null)
  const [mode, setMode] = useState<'non-dev' | 'dev'>('non-dev')
  const [repositories, setRepositories] = useState<GitHubRepository[]>()
  const [repository, setRepository] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [baseBranch, setBaseBranch] = useState('')
  const { errorMessage, isPending, run } = useGuardedAction()
  const isDev = type === 'runtime' && mode === 'dev'
  const isAdmin = useIsWorkspaceAdmin(workspaceId)
  const [loadFailure, setLoadFailure] = useState<string | null>(null)
  const [isGitHubMissing, setIsGitHubMissing] = useState(false)
  useEffect(() => {
    if (isDev && !repositories)
      commands.listRepositories({ workspaceId }).then(setRepositories, (error: Error) => {
        setRepositories([])
        if (error instanceof DomainError && error.code === 'github_not_configured') setIsGitHubMissing(true)
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
            type,
            ...(type === 'channel' && { visibility }),
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
        <SegmentedChoice
          label="Chat type"
          name="type"
          options={['channel', 'runtime']}
          labels={{ channel: 'Channel', runtime: 'Runtime' }}
          value={type}
          onChange={setType}
        />
        {type === 'channel' && (
          <SegmentedChoice
            label="Visibility"
            name="visibility"
            options={['public', 'private']}
            labels={{ public: 'Public', private: 'Private' }}
            value={visibility}
            onChange={setVisibility}
          />
        )}
        {type === 'runtime' && (
          <SegmentedChoice
            label="Mode"
            name="mode"
            options={['non-dev', 'dev']}
            labels={{ 'non-dev': 'Non-dev', dev: 'Dev' }}
            value={mode}
            onChange={setMode}
          />
        )}
        {isDev && isGitHubMissing && (
          <p className="text-sm text-muted">
            {isAdmin ? (
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
          disabled={draftName.trim() === '' || isPending || (isDev && (!repository || !baseBranch))}
        >
          Confirm
        </button>
      </form>
    </Dialog>
  )
}
