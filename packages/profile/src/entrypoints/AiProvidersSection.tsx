import { useQuery } from '@spyria/db/react'
import type { WorkspaceId } from '@spyria/kernel'
import { buttonClass, ErrorMessage, LabelledSection, Switch, useGuardedAction } from '@spyria/ui'
import { withProvider } from '../domain/ai-providers.ts'
import { getAiProviders } from '../queries/get-ai-providers.ts'
import { useProfileCommands } from './providers.tsx'

export const AiProvidersSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useProfileCommands()
  const { allowList, providers } = useQuery(getAiProviders, workspaceId)
  const { errorMessage, isPending, run } = useGuardedAction()
  const save = (changed: readonly string[] | null) =>
    run(() => commands.setAiProviders({ workspaceId, allowList: changed }))
  return (
    <LabelledSection title="AI providers">
      <p className="text-sm text-muted">
        {allowList === null
          ? 'Members can add keys for every provider and use all its models.'
          : 'Members can add keys for, and use the models of, only the providers turned on here.'}{' '}
        Sessions on a member's own machine use their own subscription and are not covered.
      </p>
      <ul aria-label="AI providers" className="flex flex-col divide-y divide-line rounded-lg border border-line">
        {providers.map((provider) => (
          <li key={provider.id} className="px-4 py-3">
            <Switch
              label={provider.name}
              isOn={provider.isAllowed}
              onToggle={() => !isPending && save(withProvider(allowList, provider.id, !provider.isAllowed))}
            />
          </li>
        ))}
      </ul>
      {allowList !== null && (
        <button type="button" className={`${buttonClass} self-start`} disabled={isPending} onClick={() => save(null)}>
          Allow every provider
        </button>
      )}
      <ErrorMessage message={errorMessage} />
    </LabelledSection>
  )
}
