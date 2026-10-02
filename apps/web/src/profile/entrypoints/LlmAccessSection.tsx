import { useQuery } from '@hq/db'
import type { CredentialId, MemberId, WorkspaceId } from '@hq/kernel'
import { ghostButtonClass } from '@hq/ui'
import { useState } from 'react'
import { getLlmCredentials } from '../queries/get-llm-credentials.ts'
import { AddCredentialForm } from './AddCredentialForm.tsx'
import { RemoveCredentialDialog } from './RemoveCredentialDialog.tsx'
import { Section } from './Section.tsx'

const kindLabels = { 'api-key': 'API key', 'plan-login': 'Plan login' }
const badgeClass = 'rounded-full border border-line px-2 py-0.5 text-xs text-muted'

export const LlmAccessSection = ({ workspaceId, memberId }: { workspaceId: WorkspaceId; memberId: MemberId }) => {
  const credentials = useQuery(getLlmCredentials(workspaceId, memberId))
  const [removing, setRemoving] = useState<{ id: CredentialId; provider: string } | null>(null)
  return (
    <Section title="LLM access">
      {credentials.length === 0 ? (
        <p className="text-sm text-muted">No LLM keys yet</p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {credentials.map(({ id, provider, kind, label, last4, status }) => (
            <li key={id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium">{provider}</span>
              <span className="text-muted">{kindLabels[kind]}</span>
              {kind === 'plan-login' && <span className={badgeClass}>Plan</span>}
              {status && <span className="text-muted">{status}</span>}
              {label && <span className="text-muted">{label}</span>}
              <span className="text-muted">••••{last4}</span>
              <button
                type="button"
                aria-label={`Remove ${provider}`}
                className={`ml-auto ${ghostButtonClass}`}
                onClick={() => setRemoving({ id, provider })}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <AddCredentialForm workspaceId={workspaceId} memberId={memberId} />
      {removing && (
        <RemoveCredentialDialog
          workspaceId={workspaceId}
          memberId={memberId}
          credentialId={removing.id}
          provider={removing.provider}
          onClose={() => setRemoving(null)}
        />
      )}
    </Section>
  )
}
