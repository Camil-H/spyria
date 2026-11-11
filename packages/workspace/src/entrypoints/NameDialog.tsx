import { buttonClass, Dialog, ErrorMessage, fieldClass, labelClass, useGuardedAction } from '@spyria/ui'
import { type SubmitEvent, useState } from 'react'
import { Name } from '../domain/name.ts'

const selectOnMount = (input: HTMLInputElement | null) => input?.select()

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
  const { errorMessage, isPending, run } = useGuardedAction()
  const confirm = async (event: SubmitEvent) => {
    event.preventDefault()
    if (await run(() => submit(Name(draftName)))) onClose()
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
            ref={selectOnMount}
          />
        </label>
        <ErrorMessage message={errorMessage} />
        <button type="submit" className={buttonClass} disabled={isPending || draftName.trim() === ''}>
          Confirm
        </button>
      </form>
    </Dialog>
  )
}
