import type { Database } from '@spyria/db/postgres'
import { memberActor, memberId } from '@spyria/kernel'
import {
  ClaimableDomain,
  ClaimNeedsSso,
  DomainClaimedElsewhere,
  DomainClaimNotFound,
  type DomainClaimView,
  hasVerificationRecord,
  requireOwnAddressInside,
  VerificationRecordNotFound,
  verificationRecordOf,
} from '@spyria/workspace/server'
import type { Sql } from './sessions.ts'
import { recordWorkspaceEvent, requireMemberPermission } from './sso.ts'

export type ResolveTxt = (domain: string) => Promise<string[][]>
type Member = { workspaceId: string; userId: string }
type StoredClaim = { domain: string; token: string; isVerified: boolean }

const uniqueViolation = '23505'

const claimsOf = (sql: Sql, workspaceId: string) =>
  sql<StoredClaim[]>`
    select domain, token, verified_at is not null as "isVerified" from domain_claims
    where workspace_id = ${workspaceId} order by domain`

const viewsOf = (claims: StoredClaim[]): DomainClaimView[] =>
  claims.map(({ domain, token, isVerified }) => ({ domain, record: verificationRecordOf(token), isVerified }))

const verifiedDomainsOf = (claims: StoredClaim[]) =>
  claims.filter(({ isVerified }) => isVerified).map(({ domain }) => domain)

const emailOf = async (sql: Sql, userId: string) =>
  (await sql<{ email: string }[]>`select email from users where id = ${userId}`)[0]?.email ?? ''

const asManager = <Result>(database: Database, member: Member, work: (sql: Sql) => Promise<Result>) =>
  database.$client.begin(async (sql) => {
    await requireMemberPermission(sql, member, 'sso.manage')
    return work(sql)
  })

export const listDomainClaims = (database: Database, member: Member) =>
  asManager(database, member, async (sql) => viewsOf(await claimsOf(sql, member.workspaceId)))

export const claimDomain = (database: Database, member: Member, text: unknown) =>
  asManager(database, member, async (sql) => {
    const domain = ClaimableDomain(String(text ?? ''))
    const [enforcesSso] = await sql`select 1 from workspace_sso where workspace_id = ${member.workspaceId}`
    if (!enforcesSso) throw new ClaimNeedsSso()
    const [claimedElsewhere] = await sql`
      select 1 from domain_claims where domain = ${domain} and verified_at is not null
        and workspace_id <> ${member.workspaceId}`
    if (claimedElsewhere) throw new DomainClaimedElsewhere(domain)
    await sql`
      insert into domain_claims (workspace_id, domain, token, created_at)
      values (${member.workspaceId}, ${domain}, ${crypto.randomUUID().replaceAll('-', '')}, now())
      on conflict do nothing`
    return viewsOf(await claimsOf(sql, member.workspaceId))
  })

export const verifyDomainClaim = async (database: Database, resolveTxt: ResolveTxt, member: Member, text: unknown) => {
  const domain = ClaimableDomain(String(text ?? ''))
  const pending = await asManager(database, member, async (sql) =>
    (await claimsOf(sql, member.workspaceId)).find((claim) => claim.domain === domain),
  )
  if (!pending) throw new DomainClaimNotFound(domain)
  if (!pending.isVerified && !hasVerificationRecord(await resolveTxt(domain).catch(() => []), pending.token))
    throw new VerificationRecordNotFound(domain)
  return asManager(database, member, async (sql) => {
    const claims = await claimsOf(sql, member.workspaceId)
    requireOwnAddressInside(await emailOf(sql, member.userId), [...verifiedDomainsOf(claims), domain])
    const verified = await sql`
      update domain_claims set verified_at = now()
      where workspace_id = ${member.workspaceId} and domain = ${domain} and token = ${pending.token}
        and verified_at is null
      returning 1`.catch((error: { code?: string }) => {
      if (error.code === uniqueViolation) throw new DomainClaimedElsewhere(domain)
      throw error
    })
    if (verified.length > 0)
      await recordWorkspaceEvent(sql, member.workspaceId, 'domain.claimed', memberActor(memberId(member.userId)), {
        domain,
      })
    return viewsOf(await claimsOf(sql, member.workspaceId))
  })
}

export const releaseDomainClaim = (database: Database, member: Member, text: unknown) =>
  asManager(database, member, async (sql) => {
    const domain = ClaimableDomain(String(text ?? ''))
    const claims = await claimsOf(sql, member.workspaceId)
    const released = claims.find((claim) => claim.domain === domain)
    if (!released) throw new DomainClaimNotFound(domain)
    if (released.isVerified)
      requireOwnAddressInside(
        await emailOf(sql, member.userId),
        verifiedDomainsOf(claims).filter((claimed) => claimed !== domain),
      )
    await sql`delete from domain_claims where workspace_id = ${member.workspaceId} and domain = ${domain}`
    if (released.isVerified)
      await recordWorkspaceEvent(sql, member.workspaceId, 'domain.released', memberActor(memberId(member.userId)), {
        domain,
      })
    return viewsOf(await claimsOf(sql, member.workspaceId))
  })
