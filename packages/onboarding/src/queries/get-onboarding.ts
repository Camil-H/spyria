import { type Snapshot, workspacePermissionsIn } from '@spyria/db'
import type { MemberId, WorkspaceId } from '@spyria/kernel'
import { isOnboardingTask, type OnboardingFacts, tasksToRecordOf, taskViewsOf } from '../domain/tasks.ts'

const seenHostStatuses = new Set(['online', 'offline'])

export const getOnboarding =
  (workspaceId: WorkspaceId, memberId: MemberId, usesSingleSignOn: boolean) => (snapshot: Snapshot) => {
    const inWorkspace = <Row extends { workspaceId: WorkspaceId }>(rows: readonly Row[]) =>
      rows.filter((row) => row.workspaceId === workspaceId)
    const own = <Row extends { workspaceId: WorkspaceId; memberId: MemberId }>(rows: readonly Row[]) =>
      inWorkspace(rows).filter((row) => row.memberId === memberId)
    const memberships = inWorkspace(snapshot.memberships).filter((membership) => membership.removedAt === null)
    const ssoDomains = inWorkspace(snapshot.ssoDomains)
    const facts: OnboardingFacts = {
      isDomainVerified: ssoDomains.some((domain) => domain.isVerified),
      hasGitHubApp: inWorkspace(snapshot.githubApps).length > 0,
      hasClaimedRuntimeHost: inWorkspace(snapshot.runtimeHosts).some(
        (host) => host.ownerId === null && seenHostStatuses.has(host.status),
      ),
      hasInvitedSomeone:
        inWorkspace(snapshot.invitations).length > 0 ||
        memberships.some((membership) => membership.memberId !== memberId),
      hasAiKey: own(snapshot.llmCredentials).length > 0,
      hasGitHubAccount: own(snapshot.githubConnections).length > 0,
      hasProfilePicture: memberships.some(
        (membership) => membership.memberId === memberId && membership.avatar !== null,
      ),
    }
    const memberRows = own(snapshot.memberOnboarding)
    const tasksOf = (rows: readonly { task: string }[]) =>
      new Set(rows.map(({ task }) => task).filter(isOnboardingTask))
    const records = {
      completed: tasksOf([
        ...inWorkspace(snapshot.workspaceOnboarding),
        ...memberRows.filter((row) => row.isCompleted),
      ]),
      skipped: tasksOf(memberRows.filter((row) => row.isSkipped)),
    }
    const permissions = workspacePermissionsIn(snapshot, workspaceId, memberId)
    return {
      tasks: taskViewsOf(facts, records, { permissions, usesSingleSignOn }),
      tasksToRecord: tasksToRecordOf(facts, records, permissions),
      domain: ssoDomains[0]?.domain,
    }
  }
