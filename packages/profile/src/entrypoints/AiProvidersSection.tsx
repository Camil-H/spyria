import { useQuery } from '@spyria/db/react'
import type { AiProviderAllowList, WorkspaceId } from '@spyria/kernel'
import {
  buttonClass,
  ErrorMessage,
  fieldClass,
  ghostButtonClass,
  LabelledSection,
  Switch,
  useGuardedAction,
} from '@spyria/ui'
import { type SubmitEvent, useState } from 'react'
import { withModels, withProvider } from '../domain/ai-providers.ts'
import { getAiProviders } from '../queries/get-ai-providers.ts'
import { useProfileCommands } from './providers.tsx'

type ListedProvider = ReturnType<ReturnType<typeof getAiProviders>>['providers'][number]

const toggled = (models: readonly string[], model: string) =>
  models.includes(model) ? models.filter((id) => id !== model) : [...models, model]

const ModelChoices = ({
  provider,
  isPending,
  save,
}: {
  provider: ListedProvider
  isPending: boolean
  save: (models: 'all' | readonly string[]) => void
}) => {
  const [addedModel, setAddedModel] = useState('')
  const chosen = provider.models === 'all' ? provider.choices.map(({ id }) => id) : provider.models
  const addModel = (event: SubmitEvent) => {
    event.preventDefault()
    const model = addedModel.trim()
    if (!model) return
    save([...new Set([...chosen, model.startsWith(`${provider.id}/`) ? model : `${provider.id}/${model}`])])
    setAddedModel('')
  }
  return (
    <div className="flex flex-col gap-2 pl-4">
      <label className="flex items-center gap-1.5 text-sm">
        <input
          type="checkbox"
          disabled={isPending}
          checked={provider.models === 'all'}
          onChange={() => save(provider.models === 'all' ? chosen : 'all')}
        />
        Every {provider.name} model
      </label>
      {provider.models !== 'all' && (
        <>
          <fieldset aria-label={`Models of ${provider.name}`} className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {provider.choices.map((model) => (
              <label key={model.id} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  disabled={isPending}
                  checked={chosen.includes(model.id)}
                  onChange={() => save(toggled(chosen, model.id))}
                />
                {model.name}
              </label>
            ))}
          </fieldset>
          <form aria-label={`Add a ${provider.name} model`} onSubmit={addModel} className="flex items-center gap-2">
            <input
              className={fieldClass}
              aria-label="Model id"
              placeholder={`${provider.id}/model-id`}
              value={addedModel}
              onChange={(event) => setAddedModel(event.target.value)}
            />
            <button type="submit" className={ghostButtonClass} disabled={isPending}>
              Add model
            </button>
          </form>
        </>
      )}
    </div>
  )
}

export const AiProvidersSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useProfileCommands()
  const { allowList, providers } = useQuery(getAiProviders, workspaceId)
  const { errorMessage, isPending, run } = useGuardedAction()
  const save = (changed: AiProviderAllowList | null) =>
    run(() => commands.setAiProviders({ workspaceId, allowList: changed }))
  return (
    <LabelledSection title="AI providers">
      <p className="text-sm text-muted">
        {allowList === null
          ? 'Members can add keys for every provider and use every model.'
          : 'Members can add keys and use models only from the providers and models allowed here.'}{' '}
        Sessions on a member's own machine use their own subscription and are not covered.
      </p>
      <ul aria-label="AI providers" className="flex flex-col gap-3">
        {providers.map((provider) => (
          <li key={provider.id} className="flex flex-col gap-2">
            <Switch
              label={provider.name}
              isOn={provider.isAllowed}
              onToggle={() => !isPending && save(withProvider(allowList, provider.id, !provider.isAllowed))}
            />
            {provider.isAllowed && (
              <ModelChoices
                provider={provider}
                isPending={isPending}
                save={(models) => save(withModels(allowList, provider.id, models))}
              />
            )}
          </li>
        ))}
      </ul>
      {allowList !== null && (
        <button type="button" className={buttonClass} disabled={isPending} onClick={() => save(null)}>
          Allow every provider and model
        </button>
      )}
      <ErrorMessage message={errorMessage} />
    </LabelledSection>
  )
}
