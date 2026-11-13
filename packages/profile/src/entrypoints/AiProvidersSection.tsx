import { useQuery } from '@spyria/db/react'
import type { WorkspaceId } from '@spyria/kernel'
import {
  ErrorMessage,
  LabelledSection,
  rowClass,
  rowListClass,
  SegmentedChoice,
  Switch,
  useGuardedAction,
} from '@spyria/ui'
import { withProvider } from '../domain/ai-providers.ts'
import { getAiProviders } from '../queries/get-ai-providers.ts'
import { useProfileCommands } from './providers.tsx'

const providerKinds = [
  { kind: 'lab', title: 'Labs' },
  { kind: 'router', title: 'Routers' },
] as const
const allowModes = ['every', 'only'] as const
const allowModeLabels = { every: 'Every provider', only: 'Only the ones turned on' }

export const AiProvidersSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useProfileCommands()
  const { allowList, providers } = useQuery(getAiProviders, workspaceId)
  const { errorMessage, isPending, run } = useGuardedAction()
  const save = (changed: readonly string[] | null) =>
    run(() => commands.setAiProviders({ workspaceId, allowList: changed }))
  return (
    <section aria-label="AI providers" className="flex flex-col gap-6">
      <div className="flex max-w-xl flex-col gap-2">
        <SegmentedChoice
          label="Members can use"
          name="ai-provider-mode"
          options={allowModes}
          labels={allowModeLabels}
          value={allowList === null ? 'every' : 'only'}
          onChange={(mode) => !isPending && save(mode === 'every' ? null : providers.map(({ id }) => id))}
        />
        <p className="text-sm text-muted">
          {allowList === null
            ? 'Members can add keys for every provider and use all its models.'
            : 'Members can add keys for, and use the models of, only the providers turned on here.'}{' '}
          Sessions on a member's own machine use their own subscription and are not covered.
        </p>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        {providerKinds.map(({ kind, title }) => (
          <LabelledSection key={kind} title={title} titleClass="text-sm font-medium">
            <ul aria-label={title} className={rowListClass}>
              {providers
                .filter((provider) => provider.kind === kind)
                .map((provider) => (
                  <li key={provider.id} className={rowClass}>
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
      </div>
      <ErrorMessage message={errorMessage} />
    </section>
  )
}
