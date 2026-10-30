import { fieldClass, labelClass, tabTriggerClass } from '@spyria/ui'
import { Plus } from 'lucide-react'
import type { ReactNode } from 'react'
import { listedRepositoriesOf, type RepositoryListing, repositoryPromptOf } from '../domain/github.ts'

export const newRepositoryTab = 'new-repository'
export type RepositoryTab = string | null

export const RepositoryTabs = ({
  label,
  defaultLabel,
  newLabel,
  repositories,
  selected,
  onSelect,
}: {
  label: string
  defaultLabel: string
  newLabel: string
  repositories: readonly string[]
  selected: RepositoryTab
  onSelect: (tab: RepositoryTab) => void
}) => {
  const tabOf = (tab: RepositoryTab, text: ReactNode) => (
    <button
      key={tab ?? 'default'}
      type="button"
      role="tab"
      aria-selected={selected === tab}
      data-state={selected === tab ? 'active' : 'inactive'}
      className={`flex items-center gap-1 ${tabTriggerClass}`}
      onClick={() => onSelect(tab)}
    >
      {text}
    </button>
  )
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-4 border-b border-line">
      {tabOf(null, defaultLabel)}
      {repositories.map((repository) => tabOf(repository, repository))}
      {tabOf(
        newRepositoryTab,
        <>
          <Plus aria-hidden size={14} />
          {newLabel}
        </>,
      )}
    </div>
  )
}

export const NewRepositoryPicker = ({
  label,
  listing,
  taken,
  own,
  note,
  onPick,
}: {
  label: string
  listing: RepositoryListing
  taken: readonly string[]
  own: string
  note: string
  onPick: (repository: string) => void
}) => {
  const available = listedRepositoriesOf(listing).filter(({ fullName }) => !taken.includes(fullName))
  return (
    <div role="tabpanel" aria-label={label} className="flex flex-col gap-3">
      <label className={`${labelClass} self-start`}>
        Repository
        <select
          className={fieldClass}
          disabled={available.length === 0}
          value=""
          onChange={(event) => onPick(event.target.value)}
        >
          <option value="">{repositoryPromptOf(listing, available.length, own)}</option>
          {available.map(({ fullName }) => (
            <option key={fullName} value={fullName}>
              {fullName}
            </option>
          ))}
        </select>
      </label>
      <p className="text-sm text-muted">{note}</p>
    </div>
  )
}
