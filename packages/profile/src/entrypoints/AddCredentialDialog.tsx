import type { WorkspaceId } from '@spyria/kernel'
import { buttonClass, Dialog, ErrorMessage, fieldClass, labelClass, useGuardedAction } from '@spyria/ui'
import { type SubmitEvent, useState } from 'react'
import { Secret } from '../domain/secret.ts'
import { useProfileCommands } from './providers.tsx'

const isFilledIn = (form: HTMLFormElement) =>
  [...new FormData(form).values()].every((value) => typeof value === 'string' && value.trim() !== '')

export const AddCredentialDialog = ({ workspaceId, onClose }: { workspaceId: WorkspaceId; onClose: () => void }) => {
  const commands = useProfileCommands()
  const { errorMessage, isPending, run } = useGuardedAction()
  const [isComplete, setIsComplete] = useState(false)
  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    const isAdded = await run(() =>
      commands.addLlmCredential({
        workspaceId,
        provider: String(fields.get('provider')),
        secret: new Secret(String(fields.get('secret'))),
      }),
    )
    if (isAdded) onClose()
  }
  return (
    <Dialog label="Add LLM key" onClose={onClose}>
      <form
        onSubmit={submit}
        onInput={(event) => setIsComplete(isFilledIn(event.currentTarget))}
        className="flex flex-col gap-3"
      >
        <label className={labelClass}>
          Provider
          <input name="provider" placeholder="Anthropic, OpenAI…" className={fieldClass} data-initial-focus />
        </label>
        <label className={labelClass}>
          Secret
          <input name="secret" type="password" autoComplete="off" className={fieldClass} />
        </label>
        <ErrorMessage message={errorMessage} />
        <button type="submit" className={buttonClass} disabled={!isComplete || isPending}>
          Add
        </button>
      </form>
    </Dialog>
  )
}
