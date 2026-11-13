import type { WorkspaceId } from '@spyria/kernel'
import {
  buttonClass,
  CopyButton,
  ErrorMessage,
  fieldClass,
  ghostButtonClass,
  LabelledSection,
  labelClass,
  StatusBadge,
  useGuardedAction,
} from '@spyria/ui'
import { type SubmitEvent, useEffect, useState } from 'react'
import type { DomainClaimView } from '../domain/domain-claim.ts'
import { useWorkspaceCommands } from './providers.tsx'

const ClaimRow = ({
  claim,
  isPending,
  verify,
  release,
}: {
  claim: DomainClaimView
  isPending: boolean
  verify: () => void
  release: () => void
}) => (
  <li aria-label={claim.domain} className="flex flex-col gap-2 rounded-md border border-line p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="font-medium">{claim.domain}</span>
      <StatusBadge tone={claim.isVerified ? 'ok' : 'attention'}>
        {claim.isVerified ? 'Claimed' : 'Waiting for the DNS record'}
      </StatusBadge>
    </div>
    {!claim.isVerified && (
      <>
        <p className="text-sm text-muted">Add this TXT record at {claim.domain}, then check it:</p>
        <div className="flex items-center gap-2">
          <code className="flex-1 font-mono text-xs break-all">{claim.record}</code>
          <CopyButton text={claim.record} label="Copy the TXT record" className={ghostButtonClass} />
        </div>
      </>
    )}
    <div className="flex flex-wrap gap-3">
      {!claim.isVerified && (
        <button type="button" className={buttonClass} disabled={isPending} onClick={verify}>
          Check the record
        </button>
      )}
      <button type="button" className={ghostButtonClass} disabled={isPending} onClick={release}>
        {claim.isVerified ? 'Release' : 'Cancel the claim'}
      </button>
    </div>
  </li>
)

export const DomainClaimsSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useWorkspaceCommands()
  const [claims, setClaims] = useState<DomainClaimView[]>()
  const [domain, setDomain] = useState('')
  const { errorMessage, isPending, run } = useGuardedAction()
  useEffect(() => {
    commands.readDomainClaims({ workspaceId }).then(setClaims, () => setClaims([]))
  }, [commands, workspaceId])
  const change = (action: () => Promise<DomainClaimView[]>) => run(async () => setClaims(await action()))
  const claim = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (await change(() => commands.claimDomain({ workspaceId, domain }))) setDomain('')
  }
  return (
    <LabelledSection title="Domains" titleClass="text-sm font-medium">
      <p className="text-sm text-muted">
        Prove your email domains with a DNS record. Their addresses then sign in only through your provider, and
        addresses at other domains lose access to this workspace.
      </p>
      {claims === undefined ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        claims.length > 0 && (
          <ul aria-label="Claimed domains" className="flex flex-col gap-2">
            {claims.map((claimed) => (
              <ClaimRow
                key={claimed.domain}
                claim={claimed}
                isPending={isPending}
                verify={() => change(() => commands.verifyDomainClaim({ workspaceId, domain: claimed.domain }))}
                release={() => change(() => commands.releaseDomainClaim({ workspaceId, domain: claimed.domain }))}
              />
            ))}
          </ul>
        )
      )}
      <form aria-label="Claim a domain" onSubmit={claim} className="flex flex-wrap items-end gap-3">
        <label className={`${labelClass} flex-1`}>
          Domain
          <input
            name="domain"
            required
            placeholder="example.com"
            className={fieldClass}
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
          />
        </label>
        <button type="submit" className={buttonClass} disabled={isPending}>
          Claim
        </button>
      </form>
      <ErrorMessage message={errorMessage} />
    </LabelledSection>
  )
}
