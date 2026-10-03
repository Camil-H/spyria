import { buttonClass, Dialog, fieldClass, labelClass } from '@hq/ui'
import { type SubmitEvent, useState } from 'react'
import { Name } from '../domain/name.ts'

export const RenameDialog = ({
  label,
  fieldLabel,
  currentName,
  rename,
  onClose,
}: {
  label: string
  fieldLabel: string
  currentName: string
  rename: (name: Name) => Promise<void>
  onClose: () => void
}) => {
  const [draftName, setDraftName] = useState(currentName)
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    await rename(Name(draftName))
    onClose()
  }
  return (
    <Dialog label={label} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className={labelClass}>
          {fieldLabel}
          <input
            className={fieldClass}
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            ref={(input) => void setTimeout(() => input?.select())}
          />
        </label>
        <button type="submit" className={buttonClass} disabled={draftName.trim() === ''}>
          Confirm
        </button>
      </form>
    </Dialog>
  )
}
