import type { SignedInThrough, WorkspaceId } from '@spyria/kernel'
import {
  AccountSignInRequired,
  ClaimedDomainCannotCreate,
  ClaimWouldLockYouOut,
  DomainClaimedElsewhere,
  InvalidDomain,
  OutsideClaimedDomains,
} from './errors.ts'

export type DomainClaimView = { domain: string; record: string; isVerified: boolean }
export type DomainClaimsOf = { claimingWorkspaceId?: WorkspaceId; workspaceDomains: readonly string[] }

const labelPattern = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
const maximumDomainLength = 253
const verificationPrefix = 'spyria-verify='

export const domainOfEmail = (email: string) => email.trim().toLowerCase().split('@')[1] ?? ''

export const ClaimableDomain = (text: string) => {
  const domain = text.trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '')
  const labels = domain.split('.')
  if (domain.length > maximumDomainLength || labels.length < 2 || !labels.every((label) => labelPattern.test(label)))
    throw new InvalidDomain(text)
  return domain
}

export const verificationRecordOf = (token: string) => `${verificationPrefix}${token}`

export const hasVerificationRecord = (records: readonly (readonly string[])[], token: string) =>
  records.some((chunks) => chunks.join('').trim() === verificationRecordOf(token))

export const requireOwnAddressInside = (email: string, claimedDomains: readonly string[]) => {
  if (claimedDomains.length > 0 && !claimedDomains.includes(domainOfEmail(email)))
    throw new ClaimWouldLockYouOut(domainOfEmail(email))
}

export const requireInvitable = (
  workspaceId: WorkspaceId,
  email: string,
  { claimingWorkspaceId, workspaceDomains }: DomainClaimsOf,
) => {
  const domain = domainOfEmail(email)
  if (claimingWorkspaceId !== undefined && claimingWorkspaceId !== workspaceId) throw new DomainClaimedElsewhere(domain)
  if (workspaceDomains.length > 0 && !workspaceDomains.includes(domain)) throw new OutsideClaimedDomains(email)
}

export const requireWorkspaceCreation = (signedInThrough: SignedInThrough) => {
  if (signedInThrough === 'workspace sso') throw new AccountSignInRequired()
  if (signedInThrough === 'claimed domain') throw new ClaimedDomainCannotCreate()
}
