import { useQuery } from '@spyria/db/react'
import {
  type DevLoopRules,
  type DevLoopSettings,
  defaultDevLoopSettings,
  devLoopRange,
  rulesOf,
  type WorkspaceId,
} from '@spyria/kernel'
import {
  buttonClass,
  ErrorMessage,
  fieldClass,
  ghostButtonClass,
  labelClass,
  Switch,
  useGuardedAction,
} from '@spyria/ui'
import { useEffect, useRef, useState } from 'react'
import { invalidRulesOf, withNewRules, withoutRules, withRules } from '../domain/dev-loop.ts'
import type { RepositoryListing } from '../domain/github.ts'
import { devLoopSettingsOf } from '../queries/get-dev-loop-settings.ts'
import { DevLoopPipelineEditor } from './DevLoopPipelineEditor.tsx'
import { useWorkspaceCommands } from './providers.tsx'
import { NewRepositoryPicker, newRepositoryTab, type RepositoryTab, RepositoryTabs } from './RepositoryTabs.tsx'

const rulesLabelOf = (repository: string | null) => repository ?? 'Default rules'
const dollarsOf = (micros: number | null) => (micros === null ? '' : String(micros / 1_000_000))
const microsOf = (dollars: string) => (dollars.trim() === '' ? null : Math.round(Number(dollars) * 1_000_000))

const RulesFields = ({ rules, onChange }: { rules: DevLoopRules; onChange: (rules: DevLoopRules) => void }) => (
  <div className="flex flex-col gap-5">
    <div className="self-start">
      <Switch
        label="Agents in dev chats go through these gates"
        isOn={rules.isOn}
        onToggle={() => onChange({ ...rules, isOn: !rules.isOn })}
      />
    </div>
    <DevLoopPipelineEditor steps={rules.steps} onChange={(steps) => onChange({ ...rules, steps })} />
    <fieldset className="flex flex-wrap gap-4">
      <legend className="mb-2 font-medium">Limits of a run through the gates</legend>
      <label className={labelClass}>
        Time limit (minutes)
        <input
          type="number"
          required
          min={devLoopRange.timeLimitMinutes.minimum}
          max={devLoopRange.timeLimitMinutes.maximum}
          className={`${fieldClass} w-28`}
          value={Number.isNaN(rules.timeLimitMinutes) ? '' : rules.timeLimitMinutes}
          onChange={(event) =>
            onChange({
              ...rules,
              timeLimitMinutes: event.target.value === '' ? Number.NaN : Number(event.target.value),
            })
          }
        />
      </label>
      <CostField
        key={rules.repository ?? 'default'}
        micros={rules.costLimitMicros}
        onChange={(costLimitMicros) => onChange({ ...rules, costLimitMicros })}
      />
    </fieldset>
  </div>
)

const CostField = ({ micros, onChange }: { micros: number | null; onChange: (micros: number | null) => void }) => {
  const [dollars, setDollars] = useState(dollarsOf(micros))
  return (
    <label className={labelClass}>
      Cost limit ($, sessions on an API key)
      <input
        type="number"
        min={0.01}
        step="0.01"
        inputMode="decimal"
        placeholder="No limit"
        className={`${fieldClass} w-36`}
        value={dollars}
        onChange={(event) => {
          setDollars(event.target.value)
          onChange(microsOf(event.target.value))
        }}
      />
    </label>
  )
}

export const DevLoopSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useWorkspaceCommands()
  const stored = useQuery(devLoopSettingsOf, workspaceId)
  const [draft, setDraft] = useState<DevLoopSettings>(stored ?? defaultDevLoopSettings)
  const [selected, setSelected] = useState<RepositoryTab>(null)
  const [listing, setListing] = useState<RepositoryListing>({ state: 'loading' })
  const [isSaved, setIsSaved] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const [invalidRules, setInvalidRules] = useState<string | null | undefined>()
  const edits = useRef(0)
  const { errorMessage, isPending, run } = useGuardedAction()
  useEffect(() => {
    commands.listRepositories({ workspaceId }).then(
      (repositories) => setListing({ state: 'listed', repositories }),
      () => setListing({ state: 'failed' }),
    )
  }, [commands, workspaceId])
  useEffect(() => {
    if (!stored || isDirty) return
    setDraft(stored)
    const isKnown = selected === newRepositoryTab || stored.rules.some(({ repository }) => repository === selected)
    if (!isKnown) setSelected(null)
  }, [stored, isDirty, selected])
  const edit = (next: DevLoopSettings) => {
    edits.current += 1
    setDraft(next)
    setIsSaved(false)
    setIsDirty(true)
    setInvalidRules(undefined)
  }
  const save = () => {
    const invalid = invalidRulesOf(draft)
    if (invalid) {
      setSelected(invalid.repository)
      return setInvalidRules(invalid.repository)
    }
    const savedEdits = edits.current
    return run(async () => {
      await commands.setDevLoop({ workspaceId, settings: draft })
      setIsSaved(true)
      if (edits.current === savedEdits) setIsDirty(false)
    })
  }
  const repositories = draft.rules.flatMap(({ repository }) => (repository === null ? [] : [repository]))
  return (
    <section aria-label="Quality gates" className="flex flex-col gap-5">
      <p className="text-sm text-muted">
        When the agent of a dev chat says its work is done, Spyria runs it through the gates of its repository, in
        order. A gate that fails sends the work back to the agent, or hands it over to the chat owner, as the gate says.
        Repositories without rules of their own follow the default rules.
      </p>
      <RepositoryTabs
        label="Rules"
        defaultLabel={rulesLabelOf(null)}
        newLabel="New repository rules"
        repositories={repositories}
        selected={selected}
        onSelect={setSelected}
      />
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault()
          save()
        }}
      >
        {selected === newRepositoryTab ? (
          <NewRepositoryPicker
            label="New repository rules"
            listing={listing}
            taken={repositories}
            own="rules"
            note="The new rules start as a copy of the default rules."
            onPick={(repository) => {
              edit(withNewRules(draft, repository))
              setSelected(repository)
            }}
          />
        ) : (
          <div role="tabpanel" aria-label={rulesLabelOf(selected)} className="flex flex-col gap-5">
            <RulesFields rules={rulesOf(draft, selected)} onChange={(rules) => edit(withRules(draft, rules))} />
            {selected !== null && (
              <button
                type="button"
                className={`self-start ${ghostButtonClass}`}
                onClick={() => {
                  edit(withoutRules(draft, selected))
                  setSelected(null)
                }}
              >
                Delete the rules of {selected}
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
        {invalidRules !== undefined && (
          <ErrorMessage
            message={`The ${invalidRules === null ? 'default rules' : `rules of ${invalidRules}`} cannot be saved: each command needs a name of its own, a command and a timeout of 1 to 120 minutes, each failure rule 1 to 10 times, the time limit 10 minutes to 24 hours, a cost limit above 0, and only CI may follow the pull request, in at most 20 gates`}
          />
        )}
      </form>
      <ErrorMessage message={errorMessage} />
    </section>
  )
}
