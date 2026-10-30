import { useQuery } from '@spyria/db/react'
import {
  type DevLoopPipeline,
  type DevLoopSettings,
  defaultDevLoopSettings,
  devLoopRange,
  pipelineOf,
  type WorkspaceId,
} from '@spyria/kernel'
import {
  buttonClass,
  ErrorMessage,
  fieldClass,
  ghostButtonClass,
  LabelledSection,
  labelClass,
  Switch,
  tabTriggerClass,
  useGuardedAction,
} from '@spyria/ui'
import { useEffect, useState } from 'react'
import { invalidPipelineOf, withoutPipeline, withPipeline } from '../domain/dev-loop.ts'
import type { GitHubRepository } from '../domain/github.ts'
import { devLoopSettingsOf } from '../queries/get-dev-loop-settings.ts'
import { DevLoopPipelineEditor } from './DevLoopPipelineEditor.tsx'
import { useWorkspaceCommands } from './providers.tsx'

const offSettings: DevLoopSettings = { ...defaultDevLoopSettings, isOn: false }
const dollarsOf = (micros: number | null) => (micros === null ? '' : String(micros / 1_000_000))
const pipelineLabelOf = (repository: string | null) => repository ?? 'Every other repository'

export const DevLoopSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useWorkspaceCommands()
  const stored = useQuery(devLoopSettingsOf, workspaceId)
  const [draft, setDraft] = useState(stored ?? offSettings)
  const [costDollars, setCostDollars] = useState(dollarsOf(draft.costLimitMicros))
  const [selected, setSelected] = useState<string | null>(null)
  const [repositories, setRepositories] = useState<GitHubRepository[]>([])
  const [added, setAdded] = useState('')
  const [checkNames, setCheckNames] = useState<string[]>([])
  const [isSaved, setIsSaved] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const [invalidPipeline, setInvalidPipeline] = useState<string | null | undefined>()
  const { errorMessage, isPending, run } = useGuardedAction()
  useEffect(() => {
    commands.listRepositories({ workspaceId }).then(setRepositories, () => setRepositories([]))
  }, [commands, workspaceId])
  useEffect(() => {
    if (!stored || isDirty) return
    setDraft(stored)
    setCostDollars(dollarsOf(stored.costLimitMicros))
    if (!stored.pipelines.some(({ repository }) => repository === selected)) setSelected(null)
  }, [stored, isDirty, selected])
  const branch = repositories.find((repository) => repository.fullName === selected)?.defaultBranch
  useEffect(() => {
    let isCurrent = true
    const show = (names: string[]) => {
      if (isCurrent) setCheckNames(names)
    }
    if (!selected || !branch) show([])
    else commands.listCheckNames({ workspaceId, repository: selected, branch }).then(show, () => show([]))
    return () => {
      isCurrent = false
    }
  }, [commands, workspaceId, selected, branch])
  const edit = (next: DevLoopSettings) => {
    setDraft(next)
    setIsSaved(false)
    setIsDirty(true)
    setInvalidPipeline(undefined)
  }
  const save = (next: DevLoopSettings) =>
    run(async () => {
      await commands.setDevLoop({ workspaceId, settings: next })
      setIsSaved(true)
      setIsDirty(false)
    })
  const saveDraft = (next: DevLoopSettings) => {
    const invalid = invalidPipelineOf(next)
    if (!invalid) return save(next)
    setSelected(invalid.repository)
    setInvalidPipeline(invalid.repository)
  }
  const pipeline = pipelineOf(draft, selected)
  const editPipeline = (next: DevLoopPipeline) => edit(withPipeline(draft, { ...next, repository: selected }))
  const withoutOwn = repositories.filter(
    ({ fullName }) => !draft.pipelines.some((known) => known.repository === fullName),
  )
  const tabs = [null, ...draft.pipelines.flatMap(({ repository }) => (repository === null ? [] : [repository]))]
  return (
    <LabelledSection title="Dev loop">
      <p className="text-sm text-muted">
        When the agent of a dev chat says its work is done, Spyria runs the steps of the repository's pipeline, in
        order. A failing step goes back to the agent or hands over to the chat owner, as each step says.
      </p>
      <Switch
        label="Agents in dev chats check their own work"
        isOn={draft.isOn}
        onToggle={() => {
          setDraft({ ...draft, isOn: !draft.isOn })
          save({ ...(stored ?? offSettings), isOn: !draft.isOn })
        }}
      />
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault()
          saveDraft({
            ...draft,
            costLimitMicros: costDollars.trim() === '' ? null : Math.round(Number(costDollars) * 1_000_000),
          })
        }}
      >
        <fieldset className="flex flex-wrap gap-4">
          <legend className="mb-2 font-medium">Limits of a loop</legend>
          <label className={labelClass}>
            Time limit (minutes)
            <input
              type="number"
              required
              min={devLoopRange.timeLimitMinutes.minimum}
              max={devLoopRange.timeLimitMinutes.maximum}
              className={`${fieldClass} w-28`}
              value={Number.isNaN(draft.timeLimitMinutes) ? '' : draft.timeLimitMinutes}
              onChange={(event) =>
                edit({
                  ...draft,
                  timeLimitMinutes: event.target.value === '' ? Number.NaN : Number(event.target.value),
                })
              }
            />
          </label>
          <label className={labelClass}>
            Cost limit ($, sessions on an API key)
            <input
              type="number"
              min={0.01}
              step="0.01"
              inputMode="decimal"
              placeholder="No limit"
              className={`${fieldClass} w-36`}
              value={costDollars}
              onChange={(event) => {
                setCostDollars(event.target.value)
                setIsDirty(true)
                setIsSaved(false)
              }}
            />
          </label>
        </fieldset>
        <section aria-label="Pipelines" className="flex flex-col gap-4">
          <h3 className="font-medium">Pipelines</h3>
          <div role="tablist" aria-label="Repositories" className="flex flex-wrap gap-4 border-b border-line">
            {tabs.map((repository) => (
              <button
                key={repository ?? 'default'}
                type="button"
                role="tab"
                aria-selected={selected === repository}
                data-state={selected === repository ? 'active' : 'inactive'}
                className={tabTriggerClass}
                onClick={() => setSelected(repository)}
              >
                {pipelineLabelOf(repository)}
              </button>
            ))}
          </div>
          {withoutOwn.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <select
                aria-label="Repository"
                className={fieldClass}
                value={added}
                onChange={(event) => setAdded(event.target.value)}
              >
                <option value="">Give a repository its own pipeline…</option>
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
                  edit(withPipeline(draft, { ...pipelineOf(draft, null), repository: added }))
                  setSelected(added)
                  setAdded('')
                }}
              >
                Add pipeline
              </button>
            </div>
          )}
          <div role="tabpanel" aria-label={pipelineLabelOf(selected)} className="flex flex-col gap-4">
            <DevLoopPipelineEditor pipeline={pipeline} checkNames={checkNames} onChange={editPipeline} />
            {selected !== null && (
              <button
                type="button"
                className={`self-start ${ghostButtonClass}`}
                onClick={() => {
                  edit(withoutPipeline(draft, selected))
                  setSelected(null)
                }}
              >
                Use the default pipeline for {selected}
              </button>
            )}
          </div>
        </section>
        <div className="flex items-center gap-3">
          <button type="submit" className={buttonClass} disabled={isPending}>
            Save
          </button>
          {isSaved && <span className="text-sm text-muted">Saved</span>}
        </div>
        {invalidPipeline !== undefined && (
          <ErrorMessage
            message={`The pipeline of ${pipelineLabelOf(invalidPipeline)} is not complete: give each command a name of its own, a command and a timeout, and each failure rule a number of times`}
          />
        )}
      </form>
      <ErrorMessage message={errorMessage} />
    </LabelledSection>
  )
}
