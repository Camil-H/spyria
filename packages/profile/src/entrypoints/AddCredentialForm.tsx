import type { WorkspaceId } from '@spyria/kernel'
import { buttonClass, ErrorMessage, fieldClass, labelClass, useGuardedAction } from '@spyria/ui'
import { type SubmitEvent, useState } from 'react'
import { Secret } from '../domain/secret.ts'
import { useProfileCommands } from './providers.tsx'
import { credentialGridClass } from './ui.ts'

const isFilledIn = (form: HTMLFormElement) =>
  [...new FormData(form).values()].every((value) => typeof value === 'string' && value.trim() !== '')

export const AddCredentialForm = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useProfileCommands()
  const { errorMessage, isPending, run } = useGuardedAction()
  const [isComplete, setIsComplete] = useState(false)
  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const fields = new FormData(form)
    const isAdded = await run(() =>
      commands.addLlmCredential({
        workspaceId,
        provider: String(fields.get('provider')),
        secret: new Secret(String(fields.get('secret'))),
      }),
    )
    if (!isAdded) return
    form.reset()
    setIsComplete(false)
  }
  return (
    <form
      onSubmit={submit}
      onInput={(event) => setIsComplete(isFilledIn(event.currentTarget))}
      className={`${credentialGridClass} items-end gap-y-3`}
    >
      <label className={labelClass}>
        Provider
        <input name="provider" className={`${fieldClass} h-9`} />
      </label>
      <label className={labelClass}>
        Secret
        <input name="secret" type="password" autoComplete="off" className={`${fieldClass} h-9`} />
      </label>
      <button type="submit" className={`${buttonClass} h-9`} disabled={!isComplete || isPending}>
        Add
      </button>
      <div className="empty:hidden sm:col-span-full">
        <ErrorMessage message={errorMessage} />
      </div>
    </form>
  )
}
