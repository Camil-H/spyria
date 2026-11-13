import { useQuery } from '@spyria/db/react'
import { maximumWarmRuntimes, type SetupCommand, type WorkspaceId } from '@spyria/kernel'
import {
  buttonClass,
  calloutClass,
  cardClass,
  ErrorMessage,
  fieldClass,
  ghostButtonClass,
  LabelledSection,
  labelClass,
  useGuardedAction,
} from '@spyria/ui'
import { useEffect, useId, useRef, useState } from 'react'
import type { RepositoryListing } from '../domain/github.ts'
import { setupCommandsOf } from '../queries/get-setup-commands.ts'
import { useWorkspaceCommands } from './providers.tsx'
import { NewRepositoryPicker, newRepositoryTab, type RepositoryTab, RepositoryTabs } from './RepositoryTabs.tsx'

type Row = { repository: string | null; command: string; warmRuntimes?: number }

const defaultLabel = 'Default setup command'
const rowsOf = (commands: readonly SetupCommand[]): Row[] => [
  { repository: null, command: commands.find(({ repository }) => repository === null)?.command ?? '' },
  ...commands.filter(({ repository }) => repository !== null),
]
const commandsOf = (rows: Row[]) => rows.filter(({ command }) => command.trim() !== '')
const warmRuntimesOf = (value: string) => Math.min(maximumWarmRuntimes, Math.max(0, Math.trunc(Number(value) || 0)))
const repositoriesOf = (rows: Row[]) => rows.flatMap(({ repository }) => (repository === null ? [] : [repository]))

export const SetupCommandsSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useWorkspaceCommands()
  const stored = useQuery(setupCommandsOf, workspaceId)
  const [rows, setRows] = useState(rowsOf(stored))
  const [selected, setSelected] = useState<RepositoryTab>(null)
  const [listing, setListing] = useState<RepositoryListing>({ state: 'loading' })
  const [isSaved, setIsSaved] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const [blankRepository, setBlankRepository] = useState<string | null>(null)
  const edits = useRef(0)
  const warmRuntimesHintId = useId()
  const { errorMessage, isPending, run } = useGuardedAction()
  useEffect(() => {
    commands.listRepositories({ workspaceId }).then(
      (repositories) => setListing({ state: 'listed', repositories }),
      () => setListing({ state: 'failed' }),
    )
  }, [commands, workspaceId])
  useEffect(() => {
    if (isDirty) return
    setRows(rowsOf(stored))
    const isKnown = selected === newRepositoryTab || stored.some(({ repository }) => repository === selected)
    if (!isKnown) setSelected(null)
  }, [stored, isDirty, selected])
  const edit = (next: Row[]) => {
    edits.current += 1
    setRows(next)
    setIsSaved(false)
    setIsDirty(true)
    setBlankRepository(null)
  }
  const save = () => {
    const blank = rows.find(({ repository, command }) => repository !== null && command.trim() === '')
    if (blank?.repository) {
      setSelected(blank.repository)
      return setBlankRepository(blank.repository)
    }
    const savedEdits = edits.current
    return run(async () => {
      await commands.setSetupCommands({ workspaceId, commands: commandsOf(rows) })
      setIsSaved(true)
      if (edits.current === savedEdits) setIsDirty(false)
    })
  }
  const repositories = repositoriesOf(rows)
  const row = rows.find(({ repository }) => repository === selected)
  return (
    <LabelledSection title="Setup commands">
      <p className="-mt-2 text-sm text-muted">
        Each dev chat's runtime runs its repository's command, else the default one, when it starts and after each
        restart, before the agent gets a message. Nothing runs without one.
      </p>
      <details className="text-sm text-muted">
        <summary className="cursor-pointer text-ink">Writing a good setup command</summary>
        <p className="mt-1">
          Keep the logic in a script of the repository, such as sh .spyria/setup.sh, and make it safe to run twice.
        </p>
      </details>
      <p className={calloutClass}>Every member can read these commands: never put a secret in one.</p>
      <RepositoryTabs
        label="Setup commands"
        defaultLabel={defaultLabel}
        newLabel="New repository setup command"
        repositories={repositories}
        selected={selected}
        onSelect={setSelected}
      />
      <form
        className={`${cardClass} flex flex-col gap-5 p-4`}
        onSubmit={(event) => {
          event.preventDefault()
          save()
        }}
      >
        {selected === newRepositoryTab || !row ? (
          <NewRepositoryPicker
            label="New repository setup command"
            listing={listing}
            taken={repositories}
            own="setup command"
            note="Repositories without a setup command of their own run the default one."
            onPick={(repository) => {
              edit([...rows, { repository, command: '' }])
              setSelected(repository)
            }}
          />
        ) : (
          <div role="tabpanel" aria-label={row.repository ?? defaultLabel} className="flex flex-col gap-5">
            <label className={labelClass}>
              Setup command
              <input
                placeholder={row.repository ? 'sh .spyria/setup.sh' : 'None'}
                maxLength={2_000}
                className={`${fieldClass} font-mono`}
                value={row.command}
                onChange={(event) =>
                  edit(rows.map((known) => (known === row ? { ...row, command: event.target.value } : known)))
                }
              />
            </label>
            {row.repository !== null && (
              <div className="flex flex-col gap-1">
                <label className={labelClass}>
                  Runtimes kept ready
                  <input
                    type="number"
                    min={0}
                    max={maximumWarmRuntimes}
                    aria-describedby={warmRuntimesHintId}
                    className={`${fieldClass} w-24`}
                    value={row.warmRuntimes ?? 0}
                    onChange={(event) =>
                      edit(
                        rows.map((known) =>
                          known === row ? { ...row, warmRuntimes: warmRuntimesOf(event.target.value) } : known,
                        ),
                      )
                    }
                  />
                </label>
                <p id={warmRuntimesHintId} className="text-xs text-muted">
                  Started ahead on the runtime hosts with setup already run on the default branch, so a new dev chat on
                  it starts at once. Each one counts as a runtime on its host.
                </p>
              </div>
            )}
            {row.repository !== null && (
              <button
                type="button"
                className={`self-start ${ghostButtonClass}`}
                onClick={() => {
                  edit(rows.filter((known) => known !== row))
                  setSelected(null)
                }}
              >
                Delete the setup command of {row.repository}
              </button>
            )}
          </div>
        )}
        <div className="flex items-center gap-3">
          <button type="submit" className={buttonClass} disabled={isPending}>
            Save
          </button>
          {isSaved && <span className="text-sm text-muted">Saved</span>}
        </div>
        {blankRepository && <ErrorMessage message={`Give ${blankRepository} a setup command, or delete it`} />}
      </form>
      <ErrorMessage message={errorMessage} />
    </LabelledSection>
  )
}
