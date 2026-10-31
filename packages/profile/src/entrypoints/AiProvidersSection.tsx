import { useQuery } from '@spyria/db/react'
import type { WorkspaceId } from '@spyria/kernel'
import { buttonClass, ErrorMessage, LabelledSection, Switch, useGuardedAction } from '@spyria/ui'
import { withProvider } from '../domain/ai-providers.ts'
import { getAiProviders } from '../queries/get-ai-providers.ts'
import { useProfileCommands } from './providers.tsx'

const providerKinds = [
  { kind: 'lab', title: 'Labs' },
  { kind: 'router', title: 'Routers' },
] as const

export const AiProvidersSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useProfileCommands()
  const { allowList, providers } = useQuery(getAiProviders, workspaceId)
  const { errorMessage, isPending, run } = useGuardedAction()
  const save = (changed: readonly string[] | null) =>
    run(() => commands.setAiProviders({ workspaceId, allowList: changed }))
  return (
    <section aria-label="AI providers" className="flex flex-col gap-5">
      <p className="text-sm text-muted">
        {allowList === null
          ? 'Members can add keys for every provider and use all its models.'
          : 'Members can add keys for, and use the models of, only the providers turned on here.'}{' '}
        Sessions on a member's own machine use their own subscription and are not covered.
      </p>
      {providerKinds.map(({ kind, title }) => (
        <LabelledSection key={kind} title={title} titleClass="text-sm font-medium">
          <ul aria-label={title} className="flex max-w-md flex-col divide-y divide-line rounded-lg border border-line">
            {providers
              .filter((provider) => provider.kind === kind)
              .map((provider) => (
                <li key={provider.id} className="px-4 py-2.5">
                  <Switch
                    label={provider.name}
                    isOn={provider.isAllowed}
                    onToggle={() => !isPending && save(withProvider(allowList, provider.id, !provider.isAllowed))}
                  />
                </li>
              ))}
          </ul>
        </LabelledSection>
      ))}
      {allowList !== null && (
        <button type="button" className={`${buttonClass} self-start`} disabled={isPending} onClick={() => save(null)}>
          Allow every provider
        </button>
      )}
      <ErrorMessage message={errorMessage} />
    </section>
  )
}
