import { useQuery } from '@spyria/db/react'
import type { WorkspaceId } from '@spyria/kernel'
import {
  ErrorMessage,
  ghostButtonClass,
  LabelledSection,
  rowClass,
  rowListClass,
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

export const AiProvidersSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useProfileCommands()
  const { allowList, providers } = useQuery(getAiProviders, workspaceId)
  const { errorMessage, isPending, run } = useGuardedAction()
  const save = (changed: readonly string[] | null) =>
    run(() => commands.setAiProviders({ workspaceId, allowList: changed }))
  return (
    <section aria-label="AI providers" className="flex flex-col gap-6">
      <div className="flex max-w-xl flex-col items-start gap-2">
        <p className="text-sm text-muted">
          Members can add keys for, and use the models of, the providers turned on here. Sessions on a member's own
          machine use their own subscription and are not covered.
        </p>
        {allowList !== null && (
          <button type="button" className={ghostButtonClass} disabled={isPending} onClick={() => save(null)}>
            Turn every provider on
          </button>
        )}
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
