import type { Transaction } from '@rocicorp/zero'
import { transactorOver, workspacePermissionsOf, type ZeroContext, zql } from '@spyria/db/zero-queries'
import type { OnboardingTransactor, UnitOfWork } from '../contracts/transactor.ts'
import { isOnboardingTask, type OnboardingTask, scopeOf } from '../domain/tasks.ts'

const seenHostStatuses = ['online', 'offline'] as const

export const createZeroTransactor = (tx: Transaction, { workspaceId, userId }: ZeroContext): OnboardingTransactor => {
  const isFound = async (row: Promise<unknown>) => (await row) !== undefined
  const ownRows = zql.memberOnboarding.where('workspaceId', workspaceId).where('userId', userId)
  const ownRow = (task: OnboardingTask) => tx.run(ownRows.where('task', task).one())
  const saveOwnRow = async (task: OnboardingTask, change: { completedAt?: number; skippedAt?: number | null }) => {
    const key = { workspaceId, userId, task }
    if (await ownRow(task)) await tx.mutate.memberOnboarding.update({ ...key, ...change })
    else await tx.mutate.memberOnboarding.insert({ completedAt: null, skippedAt: null, ...key, ...change })
  }
  const unitOfWork: UnitOfWork = {
    onboarding: {
      facts: async () => ({
        isDomainVerified: await isFound(
          tx.run(zql.ssoDomains.where('workspaceId', workspaceId).where('verifiedAt', 'IS NOT', null).one()),
        ),
        hasGitHubApp: await isFound(tx.run(zql.githubApps.where('workspaceId', workspaceId).one())),
        hasClaimedRuntimeHost: await isFound(
          tx.run(
            zql.runtimeHosts
              .where('workspaceId', workspaceId)
              .where('ownerId', 'IS', null)
              .where('removedAt', 'IS', null)
              .where('status', 'IN', seenHostStatuses)
              .one(),
          ),
        ),
        hasInvitedSomeone:
          (await isFound(
            tx.run(
              zql.invitations
                .where('workspaceId', workspaceId)
                .where('revokedAt', 'IS', null)
                .where('acceptedAt', 'IS', null)
                .one(),
            ),
          )) ||
          (await isFound(
            tx.run(
              zql.memberships
                .where('workspaceId', workspaceId)
                .where('userId', '!=', userId)
                .where('removedAt', 'IS', null)
                .one(),
            ),
          )),
        hasAiKey: await isFound(
          tx.run(zql.llmCredentials.where('workspaceId', workspaceId).where('userId', userId).one()),
        ),
        hasGitHubAccount: await isFound(
          tx.run(zql.githubConnections.where('workspaceId', workspaceId).where('userId', userId).one()),
        ),
        hasProfilePicture: await isFound(
          tx.run(
            zql.memberships
              .where('workspaceId', workspaceId)
              .where('userId', userId)
              .where('avatar', 'IS NOT', null)
              .one(),
          ),
        ),
      }),
      records: async () => {
        const workspaceRows = await tx.run(zql.workspaceOnboarding.where('workspaceId', workspaceId))
        const memberRows = await tx.run(ownRows)
        const tasksOf = (rows: readonly { task: string }[]) =>
          new Set(rows.map(({ task }) => task).filter(isOnboardingTask))
        return {
          completed: tasksOf([...workspaceRows, ...memberRows.filter((row) => row.completedAt != null)]),
          skipped: tasksOf(memberRows.filter((row) => row.skippedAt != null)),
        }
      },
      permissions: () => workspacePermissionsOf(tx, workspaceId, userId),
      recordCompleted: async (task) => {
        if (scopeOf(task) === 'member') return saveOwnRow(task, { completedAt: Date.now() })
        await tx.mutate.workspaceOnboarding.upsert({ workspaceId, task, completedAt: Date.now() })
      },
      skip: (task) => saveOwnRow(task, { skippedAt: Date.now() }),
    },
  }
  return transactorOver(tx, unitOfWork)
}
