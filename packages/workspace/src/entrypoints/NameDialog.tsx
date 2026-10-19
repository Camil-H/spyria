import { buttonClass, Dialog, fieldClass, labelClass } from '@spyria/ui'
import { type SubmitEvent, useState } from 'react'
import { Name } from '../domain/name.ts'

export const NameDialog = ({
  label,
  fieldLabel,
  initialName = '',
  submit,
  onClose,
}: {
  label: string
  fieldLabel: string
  initialName?: string
  submit: (name: Name) => Promise<unknown>
  onClose: () => void
}) => {
  const [draftName, setDraftName] = useState(initialName)
  const confirm = async (event: SubmitEvent) => {
    event.preventDefault()
    await submit(Name(draftName))
    onClose()
  }
  return (
    <Dialog label={label} onClose={onClose}>
      <form onSubmit={confirm} className="flex flex-col gap-3">
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
