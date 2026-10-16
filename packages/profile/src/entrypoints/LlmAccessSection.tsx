import { useQuery } from '@hq/db/react'
import type { CredentialId, MemberId, WorkspaceId } from '@hq/kernel'
import { ghostButtonClass, LabelledSection } from '@hq/ui'
import { useState } from 'react'
import { getLlmCredentials } from '../queries/get-llm-credentials.ts'
import { AddCredentialForm } from './AddCredentialForm.tsx'
import { RemoveCredentialDialog } from './RemoveCredentialDialog.tsx'
import { credentialGridClass } from './ui.ts'

export const LlmAccessSection = ({ workspaceId, memberId }: { workspaceId: WorkspaceId; memberId: MemberId }) => {
  const credentials = useQuery(getLlmCredentials(workspaceId, memberId))
  const [removing, setRemoving] = useState<{ id: CredentialId; provider: string } | null>(null)
  return (
    <LabelledSection title="LLM access">
      <AddCredentialForm workspaceId={workspaceId} />
      {credentials.length === 0 ? (
        <p className="text-sm text-muted">No LLM keys yet</p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {credentials.map(({ id, provider, last4 }) => (
            <li key={id} className={credentialGridClass}>
              <span className="font-medium">{provider}</span>
              <span className="text-muted">••••{last4}</span>
              <button
                type="button"
                aria-label={`Remove ${provider}`}
                className={`justify-self-end ${ghostButtonClass}`}
                onClick={() => setRemoving({ id, provider })}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {removing && (
        <RemoveCredentialDialog
          workspaceId={workspaceId}
          credentialId={removing.id}
          provider={removing.provider}
          onClose={() => setRemoving(null)}
        />
      )}
    </LabelledSection>
  )
}
