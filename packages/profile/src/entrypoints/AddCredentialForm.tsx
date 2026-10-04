import type { MemberId, WorkspaceId } from '@hq/kernel'
import { buttonClass, fieldClass, labelClass } from '@hq/ui'
import { type SubmitEvent, useState } from 'react'
import { Secret } from '../domain/secret.ts'
import { ErrorMessage } from './ErrorMessage.tsx'
import { useProfileCommands } from './providers.tsx'
import { credentialGridClass } from './ui.ts'
import { useGuardedAction } from './useGuardedAction.ts'

const emptyForm = { provider: '', secret: '' }

export const AddCredentialForm = ({ workspaceId, memberId }: { workspaceId: WorkspaceId; memberId: MemberId }) => {
  const commands = useProfileCommands()
  const { errorMessage, run } = useGuardedAction()
  const [form, setForm] = useState(emptyForm)
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const submittedForm = form
    setForm(emptyForm)
    const addSubmitted = () =>
      commands.addLlmCredential({
        workspaceId,
        memberId,
        provider: submittedForm.provider,
        secret: new Secret(submittedForm.secret),
      })
    if (!(await run(addSubmitted))) setForm(submittedForm)
  }
  return (
    <form onSubmit={submit} className={`${credentialGridClass} items-end gap-y-3`}>
      <label className={labelClass}>
        Provider
        <input
          className={`${fieldClass} h-9`}
          value={form.provider}
          onChange={(event) => setForm({ ...form, provider: event.target.value })}
        />
      </label>
      <label className={labelClass}>
        Secret
        <input
          type="password"
          autoComplete="off"
          className={`${fieldClass} h-9`}
          value={form.secret}
          onChange={(event) => setForm({ ...form, secret: event.target.value })}
        />
      </label>
      <button
        type="submit"
        className={`${buttonClass} h-9`}
        disabled={form.provider.trim() === '' || form.secret.trim() === ''}
      >
        Add
      </button>
      <div className="empty:hidden sm:col-span-full">
        <ErrorMessage message={errorMessage} />
      </div>
    </form>
  )
}
