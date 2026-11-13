import type { Snapshot } from '@spyria/db'
import { useQuery, useScoped } from '@spyria/db/react'
import { isAnyRuleOn, type WorkspaceId, type WorkspacePermission } from '@spyria/kernel'
import { ChecklistBlock } from '@spyria/onboarding'
import { AiProvidersSection, WorkspaceConnectionsSection } from '@spyria/profile'
import { MemberLocalRuntimesSection, RuntimeHostsSection } from '@spyria/runtime'
import { formatCost, LabelledSection } from '@spyria/ui'
import { AuditLogSection, countBudgetAlerts, UsageSection } from '@spyria/usage'
import {
  DeleteWorkspaceSection,
  DevLoopSection,
  GitHubSection,
  MembersAndRolesSection,
  SetupCommandsSection,
  SignInSection,
  useIsGitHubConfigured,
  useWorkspacePermissions,
} from '@spyria/workspace'
import { type ComponentType, use } from 'react'
import { useOutletContext, useParams } from 'react-router'
import { sharedAuthMode } from './auth.ts'
import { CardGrid, CardPage, type CardStatus, countLabelOf, type PageCard, pagePaddingClass } from './card-pages.tsx'

type SettingsCard = PageCard & {
  permissions: readonly WorkspacePermission[]
  Page: ComponentType<{
    workspaceId: WorkspaceId
    isDexSignIn: boolean
    instanceApps: readonly ('google' | 'microsoft')[]
    permissions: readonly WorkspacePermission[]
  }>
}

const RuntimeSettings = ({ workspaceId }: { workspaceId: WorkspaceId }) => (
  <div className="flex flex-col gap-10">
    <RuntimeHostsSection workspaceId={workspaceId} />
    <MemberLocalRuntimesSection workspaceId={workspaceId} />
    <SetupCommandsSection workspaceId={workspaceId} />
  </div>
)

const cardSections: readonly { title: string; cards: readonly SettingsCard[] }[] = [
  {
    title: 'Organization',
    cards: [
      {
        path: 'sso',
        title: 'Single sign-on',
        description: 'Sign members in through your identity provider',
        permissions: ['sso.manage'],
        Page: SignInSection,
      },
      {
        path: 'github',
        title: 'GitHub',
        description: 'The GitHub App dev chats clone and push with',
        permissions: ['github.manage'],
        Page: GitHubSection,
      },
      {
        path: 'team',
        title: 'Members and roles',
        description: 'Members, invites and what each role allows',
        permissions: ['members.invite', 'members.manage', 'roles.manage'],
        Page: MembersAndRolesSection,
        isWide: true,
      },
    ],
  },
  {
    title: 'Agents',
    cards: [
      {
        path: 'runtime',
        title: 'Runtimes',
        description: "Runtime hosts, members' own machines and setup commands",
        permissions: ['runtimes.manage'],
        Page: RuntimeSettings,
      },
      {
        path: 'ai-providers',
        title: 'AI providers',
        description: 'The model providers members can use',
        permissions: ['providers.manage'],
        Page: AiProvidersSection,
      },
      {
        path: 'tools',
        title: 'Tools',
        description: 'The tool servers members may use, and how they sign in',
        permissions: ['tools.manage'],
        Page: WorkspaceConnectionsSection,
      },
      {
        path: 'quality-gates',
        title: 'Quality gates',
        description: "The gates an agent's work goes through before it reaches you",
        permissions: ['github.manage'],
        Page: DevLoopSection,
        isWide: true,
      },
    ],
  },
  {
    title: 'Usage',
    cards: [
      {
        path: 'costs',
        title: 'Costs',
        description: 'Spend over time by member, project, chat and model, with what drove it',
        permissions: ['costs.view', 'budgets.manage'],
        Page: UsageSection,
        isWide: true,
      },
      {
        path: 'audit',
        title: 'Audit log',
        description: 'Who changed what in the workspace, with tool calls and publishing',
        permissions: ['audit.view'],
        Page: AuditLogSection,
        isWide: true,
      },
    ],
  },
]

const aiProvidersStatusOf = (workspace: Snapshot['workspaces'][number] | undefined) => {
  const allowList = workspace?.aiProviderAllowList ?? null
  return allowList === null ? 'Every provider allowed' : countLabelOf(allowList.length, 'allowed provider')
}

const runtimeStatusOf = (hosts: readonly Snapshot['runtimeHosts'][number][]): CardStatus => {
  const offlineCount = hosts.filter((host) => host.status === 'offline').length
  const label = countLabelOf(hosts.length, 'runtime host')
  if (hosts.length === 0) return { label, tone: 'off' }
  return offlineCount > 0 ? { label: `${label} · ${offlineCount} offline`, tone: 'attention' } : { label, tone: 'ok' }
}

const cardStatusesOf =
  (workspaceId: WorkspaceId, isDexSignIn: boolean) =>
  (snapshot: Snapshot): Readonly<Record<string, CardStatus>> => {
    const inWorkspace = <Row extends { workspaceId: WorkspaceId }>(rows: readonly Row[]) =>
      rows.filter((row) => row.workspaceId === workspaceId)
    const workspace = snapshot.workspaces.find(({ id }) => id === workspaceId)
    const memberCount = inWorkspace(snapshot.memberships).filter((membership) => membership.removedAt === null).length
    const inviteCount = inWorkspace(snapshot.invitations).length
    const customRoleCount = [...inWorkspace(snapshot.workspaceRoles), ...inWorkspace(snapshot.chatRoles)].filter(
      (role) => !role.builtIn,
    ).length
    const month = new Date().toISOString().slice(0, 7)
    const monthCostMicros = inWorkspace(snapshot.usageEntries)
      .filter((entry) => entry.month === month)
      .reduce((sum, entry) => sum + entry.costMicros, 0)
    return {
      ...(isDexSignIn && { sso: "Signs in with this deployment's Dex" }),
      team: [
        countLabelOf(memberCount, 'member'),
        inviteCount > 0 && countLabelOf(inviteCount, 'pending invite'),
        customRoleCount > 0 && countLabelOf(customRoleCount, 'custom role'),
      ]
        .filter(Boolean)
        .join(' · '),
      runtime: runtimeStatusOf(inWorkspace(snapshot.runtimeHosts).filter((host) => host.ownerId === null)),
      tools: countLabelOf(inWorkspace(snapshot.workspaceConnections).length, 'server'),
      'ai-providers': aiProvidersStatusOf(workspace),
      'quality-gates': isAnyRuleOn(workspace?.devLoop ?? null)
        ? { label: 'On', tone: 'ok' }
        : { label: 'Off', tone: 'off' },
      costs: `${formatCost(monthCostMicros)} this month`,
    }
  }

const SettingsRoute = () => {
  const workspaceId = useOutletContext<WorkspaceId>()
  const permissions = useWorkspacePermissions(workspaceId)
  const authMode = use(sharedAuthMode())
  const isDexSignIn = authMode.authMode === 'dex'
  const { card } = useParams()
  const syncedStatuses = useQuery(cardStatusesOf, workspaceId, isDexSignIn)
  const statuses = useIsGitHubConfigured(workspaceId, card === undefined)
    ? { ...syncedStatuses, github: { label: 'GitHub App connected', tone: 'ok' as const } }
    : syncedStatuses
  const month = new Date().toISOString().slice(0, 7)
  const isMonthUsageComplete = useScoped(workspaceId, 'monthUsage', { month })?.isComplete === true
  const budgetAlertCount = useQuery(countBudgetAlerts, workspaceId, month)
  const isAllowed = (settingsCard: SettingsCard) =>
    settingsCard.permissions.some((permission) => permissions.includes(permission))
  const allowedSections = cardSections
    .map((section) => ({ ...section, cards: section.cards.filter(isAllowed) }))
    .filter((section) => section.cards.length > 0)
  const openCard = cardSections.flatMap(({ cards }) => cards).find(({ path }) => path === card)
  const settingsPath = `/w/${workspaceId}/settings`
  if (openCard && !isAllowed(openCard))
    return <p className="p-6 text-muted">Your workspace role does not give access to this page</p>
  if (openCard)
    return (
      <CardPage backPath={settingsPath} backLabel="Back to Workspace settings" card={openCard}>
        <openCard.Page
          workspaceId={workspaceId}
          isDexSignIn={isDexSignIn}
          instanceApps={authMode.instanceApps}
          permissions={permissions}
        />
      </CardPage>
    )
  return (
    <div className={`flex flex-col gap-8 ${pagePaddingClass}`}>
      <h1 className="text-2xl font-semibold">Workspace settings</h1>
      <ChecklistBlock workspaceId={workspaceId} scope="workspace" />
      {allowedSections.length > 0 ? (
        allowedSections.map(({ title, cards }) => (
          <LabelledSection key={title} title={title}>
            <CardGrid
              basePath={settingsPath}
              cards={cards}
              statusOf={(path) => (path !== 'costs' || isMonthUsageComplete ? statuses[path] : undefined)}
              badgeOf={(path) =>
                path === 'costs' &&
                budgetAlertCount > 0 && (
                  <span className="rounded-full bg-removed px-2 py-0.5 text-xs font-medium">
                    {countLabelOf(budgetAlertCount, 'budget alert')}
                  </span>
                )
              }
            />
          </LabelledSection>
        ))
      ) : (
        <p className="text-muted">You have no workspace settings to manage</p>
      )}
      <DeleteWorkspaceSection workspaceId={workspaceId} />
    </div>
  )
}

export default SettingsRoute
