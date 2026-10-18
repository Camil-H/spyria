import type { Transact, ZeroContext } from '@hq/db/zero-queries'
import { auditCsvHeader, auditCsvLinesOf, auditCsvPageSize, auditFilterFrom, auditPageSize } from '../domain/audit.ts'
import { spendFilterFrom } from '../domain/spend.ts'
import { createPostgresAuditTransactor } from '../integrations/postgres-audit-log.ts'
import { createPostgresSpendTransactor } from '../integrations/postgres-spend.ts'
import { readAuditPage, readAuditRetention, setAuditRetention } from '../operations/audit-log.ts'
import { readOwnSpend, readWorkspaceSpend } from '../operations/spend.ts'

type Query = Readonly<Record<string, string | undefined>>

const dependenciesOf = (transact: Transact, context: ZeroContext) => ({
  transactor: createPostgresAuditTransactor(transact, context.workspaceId),
})

export const auditPageFromRequest = (transact: Transact, context: ZeroContext, query: Query) =>
  readAuditPage(dependenciesOf(transact, context), {
    memberId: context.userId,
    filter: auditFilterFrom(query),
    limit: auditPageSize,
    now: new Date(),
  })

export const auditCsvFromRequest = async (transact: Transact, context: ZeroContext, query: Query) => {
  const readPage = (cursor: string | null) =>
    readAuditPage(dependenciesOf(transact, context), {
      memberId: context.userId,
      filter: auditFilterFrom({ ...query, cursor: cursor ?? undefined }),
      limit: auditCsvPageSize,
      now: new Date(),
    })
  let page: Awaited<ReturnType<typeof readPage>> | null = await readPage(query.cursor ?? null)
  let isHeaderSent = false
  return new ReadableStream<string>({
    pull: async (controller) => {
      if (!page) return controller.close()
      controller.enqueue(`${isHeaderSent ? '' : auditCsvHeader}${auditCsvLinesOf(page.entries)}`)
      isHeaderSent = true
      page = page.nextCursor ? await readPage(page.nextCursor) : null
    },
  })
}

export const auditRetentionFromRequest = async (transact: Transact, context: ZeroContext, body?: unknown) => ({
  retentionDays:
    body === undefined
      ? await readAuditRetention(dependenciesOf(transact, context), { memberId: context.userId })
      : await setAuditRetention(dependenciesOf(transact, context), {
          memberId: context.userId,
          retentionDays: (body as { retentionDays?: unknown } | null)?.retentionDays,
        }),
})

const spendRequestOf = (transact: Transact, context: ZeroContext, query: Query) =>
  [
    { transactor: createPostgresSpendTransactor(transact, context.workspaceId) },
    { memberId: context.userId, filter: spendFilterFrom(query, new Date()) },
  ] as const

export const workspaceSpendFromRequest = (transact: Transact, context: ZeroContext, query: Query) =>
  readWorkspaceSpend(...spendRequestOf(transact, context, query))

export const ownSpendFromRequest = (transact: Transact, context: ZeroContext, query: Query) =>
  readOwnSpend(...spendRequestOf(transact, context, query))
