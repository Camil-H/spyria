import { useQuery } from '@spyria/db/react'
import type { SetupCommand, WorkspaceId } from '@spyria/kernel'
import {
  buttonClass,
  ErrorMessage,
  fieldClass,
  ghostButtonClass,
  LabelledSection,
  smallGhostButtonClass,
  useGuardedAction,
} from '@spyria/ui'
import { useEffect, useRef, useState } from 'react'
import { listedRepositoriesOf, type RepositoryListing, repositoryPromptOf } from '../domain/github.ts'
import { setupCommandsOf } from '../queries/get-setup-commands.ts'
import { useWorkspaceCommands } from './providers.tsx'

type Row = { repository: string | null; command: string }

const rowsOf = (commands: readonly SetupCommand[]): Row[] => [
  { repository: null, command: commands.find(({ repository }) => repository === null)?.command ?? '' },
  ...commands.filter(({ repository }) => repository !== null),
]
const commandsOf = (rows: Row[]) => rows.filter(({ command }) => command.trim() !== '')

export const SetupCommandsSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useWorkspaceCommands()
  const stored = useQuery(setupCommandsOf, workspaceId)
  const [rows, setRows] = useState(rowsOf(stored))
  const [listing, setListing] = useState<RepositoryListing>({ state: 'loading' })
  const repositories = listedRepositoriesOf(listing)
  const [added, setAdded] = useState('')
  const [isSaved, setIsSaved] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const [blankRepository, setBlankRepository] = useState<string | null>(null)
  const edits = useRef(0)
  const { errorMessage, isPending, run } = useGuardedAction()
  useEffect(() => {
    commands.listRepositories({ workspaceId }).then(
      (repositories) => setListing({ state: 'listed', repositories }),
      () => setListing({ state: 'failed' }),
    )
  }, [commands, workspaceId])
  useEffect(() => {
    if (!isDirty) setRows(rowsOf(stored))
  }, [stored, isDirty])
  const edit = (next: Row[]) => {
    edits.current += 1
    setRows(next)
    setIsSaved(false)
    setIsDirty(true)
    setBlankRepository(null)
  }
  const save = () => {
    const blank = rows.find(({ repository, command }) => repository !== null && command.trim() === '')
    if (blank?.repository) return setBlankRepository(blank.repository)
    const savedEdits = edits.current
    return run(async () => {
      await commands.setSetupCommands({ workspaceId, commands: commandsOf(rows) })
      setIsSaved(true)
      if (edits.current === savedEdits) setIsDirty(false)
    })
  }
  const withoutOwn = repositories.filter(({ fullName }) => !rows.some(({ repository }) => repository === fullName))
  return (
    <LabelledSection title="Setup commands">
      <p className="text-sm text-muted">
        When a dev chat's runtime starts, and again after each restart, it runs the setup command of its repository
        before the agent gets a message. Without one, it runs .spyria/setup.sh when the repository has it. Keep the
        logic in a script of the repository, and make it safe to run twice. Every member can read these commands: never
        put a secret in one.
      </p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          save()
        }}
      >
        <ul aria-label="Setup commands" className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.repository ?? 'default'} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-48 shrink-0">{row.repository ?? 'Every other repository'}</span>
              <input
                aria-label={`Setup command of ${row.repository ?? 'every other repository'}`}
                placeholder={row.repository ? 'bun install' : 'sh .spyria/setup.sh, when the repository has it'}
                maxLength={2_000}
                className={`${fieldClass} min-w-64 flex-1 font-mono`}
                value={row.command}
                onChange={(event) =>
                  edit(rows.map((known) => (known === row ? { ...row, command: event.target.value } : known)))
                }
              />
              {row.repository !== null && (
                <button
                  type="button"
                  className={smallGhostButtonClass}
                  onClick={() => edit(rows.filter((known) => known !== row))}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select
            aria-label="Repository"
            className={fieldClass}
            disabled={withoutOwn.length === 0}
            value={added}
            onChange={(event) => setAdded(event.target.value)}
          >
            <option value="">{repositoryPromptOf(listing, withoutOwn.length, 'setup command')}</option>
            {withoutOwn.map(({ fullName }) => (
              <option key={fullName} value={fullName}>
                {fullName}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={ghostButtonClass}
            disabled={!added}
            onClick={() => {
              edit([...rows, { repository: added, command: '' }])
              setAdded('')
            }}
          >
            Give it its own setup command
          </button>
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" className={buttonClass} disabled={isPending}>
            Save
          </button>
          {isSaved && <span className="text-sm text-muted">Saved</span>}
        </div>
        {blankRepository && <ErrorMessage message={`Give ${blankRepository} a setup command, or remove it`} />}
      </form>
      <ErrorMessage message={errorMessage} />
    </LabelledSection>
  )
}
