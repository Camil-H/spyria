import { refusalOf, type WorkspaceId } from '@spyria/kernel'
import type { DomainClaimView } from '../domain/domain-claim.ts'

export const domainClaimsPath = '/api/domain-claims'
export const domainClaimVerificationPath = `${domainClaimsPath}/verify`
export const domainClaimReleasePath = `${domainClaimsPath}/release`
export const workspaceCreationPath = '/api/workspace-creation'

type PostAsMember = (workspaceId: WorkspaceId, path: string, body?: string) => Promise<Response>
type GetAsMember = (workspaceId: WorkspaceId, path: string) => Promise<Response>
type DomainInput = { workspaceId: WorkspaceId; domain: string }

const bodyOf = async (response: Response) => {
  const body = (await response.json().catch(() => ({}))) as {
    claims?: DomainClaimView[]
    isOpen?: boolean
    error?: string
    message?: string
  }
  if (!response.ok) throw refusalOf(response.status, body)
  return body
}

export const createHttpDomainClaimCommands = (postAsMember: PostAsMember, getAsMember: GetAsMember) => {
  const claimsAfter = async (path: string, { workspaceId, domain }: DomainInput) =>
    (await bodyOf(await postAsMember(workspaceId, path, JSON.stringify({ domain })))).claims ?? []
  return {
    readDomainClaims: async ({ workspaceId }: { workspaceId: WorkspaceId }) =>
      (await bodyOf(await getAsMember(workspaceId, domainClaimsPath))).claims ?? [],
    claimDomain: (input: DomainInput) => claimsAfter(domainClaimsPath, input),
    verifyDomainClaim: (input: DomainInput) => claimsAfter(domainClaimVerificationPath, input),
    releaseDomainClaim: (input: DomainInput) => claimsAfter(domainClaimReleasePath, input),
    isWorkspaceCreationOpen: async ({ workspaceId }: { workspaceId: WorkspaceId }) =>
      (await bodyOf(await getAsMember(workspaceId, workspaceCreationPath))).isOpen === true,
  }
}
