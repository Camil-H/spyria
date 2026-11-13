import { useQuery } from '@spyria/db/react'
import type { CredentialId, MemberId, WorkspaceId } from '@spyria/kernel'
import { buttonClass, cardClass, rowClass, rowListClass, smallGhostButtonClass } from '@spyria/ui'
import { useState } from 'react'
import { getLlmCredentials } from '../queries/get-llm-credentials.ts'
import { AddCredentialDialog } from './AddCredentialDialog.tsx'
import { RemoveCredentialDialog } from './RemoveCredentialDialog.tsx'

export const LlmAccessSection = ({ workspaceId, memberId }: { workspaceId: WorkspaceId; memberId: MemberId }) => {
  const credentials = useQuery(getLlmCredentials, workspaceId, memberId)
  const [isAdding, setIsAdding] = useState(false)
  const [removing, setRemoving] = useState<{ id: CredentialId; provider: string } | null>(null)
  return (
    <section aria-label="LLM keys" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">Agents use your own key when you prompt, and the provider bills you.</p>
        <button type="button" className={buttonClass} onClick={() => setIsAdding(true)}>
          Add key
        </button>
      </div>
      {credentials.length === 0 ? (
        <p className={`${cardClass} px-4 py-6 text-center text-sm text-muted`}>No LLM keys yet</p>
      ) : (
        <ul aria-label="LLM keys" className={rowListClass}>
          {credentials.map(({ id, provider, last4 }) => (
            <li key={id} className={rowClass}>
              <span className="w-40 truncate font-medium">{provider}</span>
              <span className="text-muted">••••{last4}</span>
              <button
                type="button"
                aria-label={`Remove ${provider}`}
                className={`ml-auto ${smallGhostButtonClass}`}
                onClick={() => setRemoving({ id, provider })}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {isAdding && <AddCredentialDialog workspaceId={workspaceId} onClose={() => setIsAdding(false)} />}
      {removing && (
        <RemoveCredentialDialog
          workspaceId={workspaceId}
          credentialId={removing.id}
          provider={removing.provider}
          onClose={() => setRemoving(null)}
        />
      )}
    </section>
  )
}
