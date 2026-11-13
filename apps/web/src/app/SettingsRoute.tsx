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
  MembersSection,
  RolesSection,
  SetupCommandsSection,
  SignInSection,
  useIsGitHubConfigured,
  useWorkspacePermissions,
} from '@spyria/workspace'
import { type ComponentType, use } from 'react'
import { useOutletContext, useParams } from 'react-router'
import { sharedAuthMode } from './auth.ts'
import { CardGrid, CardPage, countLabelOf, type PageCard, pagePaddingClass } from './card-pages.tsx'

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
  <>
    <RuntimeHostsSection workspaceId={workspaceId} />
    <MemberLocalRuntimesSection workspaceId={workspaceId} />
    <SetupCommandsSection workspaceId={workspaceId} />
  </>
)

const cardSections: readonly { title: string; cards: readonly SettingsCard[] }[] = [
  {
    title: 'Setup your organization',
    cards: [
      {
        path: 'sso',
        title: 'Setup SSO',
        description: 'Sign members in through your identity provider',
        permissions: ['sso.manage'],
        Page: SignInSection,
      },
      {
        path: 'github',
        title: 'Connect GitHub',
        description: 'The GitHub App dev chats clone and push with',
        permissions: ['github.manage'],
        Page: GitHubSection,
      },
      {
        path: 'roles',
        title: 'Roles and Permissions',
        description: 'What each workspace and chat role allows',
        permissions: ['roles.manage'],
        Page: RolesSection,
      },
      {
        path: 'team',
        title: 'Manage Team',
        description: 'Members, workspace roles and invites',
        permissions: ['members.invite', 'members.manage'],
        Page: MembersSection,
      },
    ],
  },
  {
    title: 'Setup your agents',
    cards: [
      {
        path: 'runtime',
        title: 'Connect runtime',
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
    title: 'Analyze usage',
    cards: [
      {
        path: 'costs',
        title: 'Analyze costs',
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

const cardStatusesOf =
  (workspaceId: WorkspaceId, isDexSignIn: boolean) =>
  (snapshot: Snapshot): Readonly<Record<string, string>> => {
    const inWorkspace = <Row extends { workspaceId: WorkspaceId }>(rows: readonly Row[]) =>
      rows.filter((row) => row.workspaceId === workspaceId)
    const memberCount = inWorkspace(snapshot.memberships).filter((membership) => membership.removedAt === null).length
    const inviteCount = inWorkspace(snapshot.invitations).length
    const roles = [...inWorkspace(snapshot.workspaceRoles), ...inWorkspace(snapshot.chatRoles)]
    const customRoleCount = roles.filter((role) => !role.builtIn).length
    const month = new Date().toISOString().slice(0, 7)
    const monthCostMicros = inWorkspace(snapshot.usageEntries)
      .filter((entry) => entry.month === month)
      .reduce((sum, entry) => sum + entry.costMicros, 0)
    return {
      ...(isDexSignIn && { sso: "Signs in with this deployment's Dex" }),
      roles: [
        countLabelOf(roles.filter((role) => role.builtIn).length, 'built-in role'),
        customRoleCount > 0 && countLabelOf(customRoleCount, 'custom role'),
      ]
        .filter(Boolean)
        .join(' · '),
      team: [countLabelOf(memberCount, 'member'), inviteCount > 0 && countLabelOf(inviteCount, 'pending invite')]
        .filter(Boolean)
        .join(' · '),
      runtime: countLabelOf(
        inWorkspace(snapshot.runtimeHosts).filter((host) => host.ownerId === null).length,
        'runtime host',
      ),
      tools: countLabelOf(inWorkspace(snapshot.workspaceConnections).length, 'server'),
      'ai-providers': aiProvidersStatusOf(snapshot.workspaces.find((workspace) => workspace.id === workspaceId)),
      'quality-gates': isAnyRuleOn(
        snapshot.workspaces.find((workspace) => workspace.id === workspaceId)?.devLoop ?? null,
      )
        ? 'On'
        : 'Off',
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
    ? { ...syncedStatuses, github: 'GitHub App connected' }
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
