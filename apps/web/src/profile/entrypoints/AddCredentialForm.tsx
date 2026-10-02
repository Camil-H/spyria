import { useQuery } from '@hq/db'
import type { MemberId, WorkspaceId } from '@hq/kernel'
import { buttonClass, fieldClass, labelClass } from '@hq/ui'
import { type SubmitEvent, useId, useState } from 'react'
import { addLlmCredential } from '../operations/add-llm-credential.ts'
import { getCatalogs } from '../queries/get-catalogs.ts'
import { ErrorMessage } from './ErrorMessage.tsx'
import { useProfileDependencies } from './providers.tsx'
import { credentialGridClass } from './ui.ts'
import { useGuardedAction } from './useGuardedAction.ts'

type Kind = 'api-key' | 'plan-login'
const emptyForm = { provider: '', kind: 'api-key' as Kind, secret: '' }

export const AddCredentialForm = ({ workspaceId, memberId }: { workspaceId: WorkspaceId; memberId: MemberId }) => {
  const dependencies = useProfileDependencies()
  const planLoginHarnesses = useQuery(getCatalogs())
  const { errorMessage, run } = useGuardedAction()
  const harnessListId = useId()
  const [form, setForm] = useState(emptyForm)
  const isPlanLogin = form.kind === 'plan-login'
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (await run(() => addLlmCredential(dependencies, { workspaceId, memberId, ...form }))) setForm(emptyForm)
  }
  return (
    <form onSubmit={submit} className={`${credentialGridClass} items-end gap-y-3`}>
      <label className={labelClass}>
        Provider
        <input
          className={`${fieldClass} h-9`}
          list={isPlanLogin ? harnessListId : undefined}
          value={form.provider}
          onChange={(event) => setForm({ ...form, provider: event.target.value })}
        />
      </label>
      <datalist id={harnessListId}>
        {planLoginHarnesses.map((harness) => (
          <option key={harness} value={harness} />
        ))}
      </datalist>
      <label className={labelClass}>
        Kind
        <select
          className={`${fieldClass} h-9`}
          value={form.kind}
          onChange={(event) => setForm({ ...form, kind: event.target.value as Kind })}
        >
          <option value="api-key">API key</option>
          <option value="plan-login">Plan login</option>
        </select>
      </label>
      <label className={labelClass}>
        {isPlanLogin ? 'Credential' : 'Secret'}
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
