import { DevLoopSection } from '@spyria/conversation'
import type { Snapshot } from '@spyria/db'
import { useQuery, useScoped } from '@spyria/db/react'
import type { WorkspaceId, WorkspacePermission } from '@spyria/kernel'
import { ChecklistBlock } from '@spyria/onboarding'
import { AiProvidersSection, WorkspaceConnectionsSection } from '@spyria/profile'
import { RuntimeHostsSection } from '@spyria/runtime'
import { focusRing, formatCost, iconButtonClass, LabelledSection, useShortcut } from '@spyria/ui'
import { AuditLogSection, countBudgetAlerts, UsageSection } from '@spyria/usage'
import {
  DeleteWorkspaceSection,
  GitHubSection,
  MembersSection,
  RolesSection,
  SignInSection,
  useIsGitHubConfigured,
  useWorkspacePermissions,
} from '@spyria/workspace'
import { ArrowLeft } from 'lucide-react'
import { type ComponentType, use } from 'react'
import { Link, useNavigate, useOutletContext, useParams } from 'react-router'
import { sharedAuthMode } from './auth.ts'

type SettingsCard = {
  path: string
  title: string
  description: string
  permissions: readonly WorkspacePermission[]
  Page: ComponentType<{
    workspaceId: WorkspaceId
    isDexSignIn: boolean
    instanceApps: readonly ('google' | 'microsoft')[]
    permissions: readonly WorkspacePermission[]
  }>
}

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
        description: "Runtime hosts and members' own machines",
        permissions: ['runtimes.manage'],
        Page: RuntimeHostsSection,
      },
      {
        path: 'ai-providers',
        title: 'AI providers',
        description: 'The model providers members can use',
        permissions: ['providers.manage'],
        Page: AiProvidersSection,
      },
      {
        path: 'mcp-tools',
        title: 'MCP tools',
        description: 'Tool servers shared with the workspace',
        permissions: ['tools.manage'],
        Page: WorkspaceConnectionsSection,
      },
      {
        path: 'dev-loop',
        title: 'Dev loop',
        description: 'How the agents of dev chats check, review and publish their own work',
        permissions: ['github.manage'],
        Page: DevLoopSection,
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
      },
      {
        path: 'audit',
        title: 'Audit log',
        description: 'Who changed what in the workspace, with tool calls and publishing',
        permissions: ['audit.view'],
        Page: AuditLogSection,
      },
    ],
  },
]

const aiProvidersStatusOf = (workspace: Snapshot['workspaces'][number] | undefined) => {
  const allowList = workspace?.aiProviderAllowList ?? null
  return allowList === null ? 'Every provider allowed' : countLabelOf(allowList.length, 'allowed provider')
}

const countLabelOf = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

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
      'mcp-tools': countLabelOf(inWorkspace(snapshot.workspaceConnections).length, 'shared connection'),
      'ai-providers': aiProvidersStatusOf(snapshot.workspaces.find((workspace) => workspace.id === workspaceId)),
      'dev-loop': snapshot.workspaces.find((workspace) => workspace.id === workspaceId)?.devLoop ? 'On' : 'Off',
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
  const navigate = useNavigate()
  useShortcut('escape', 'Back to Workspace settings', () => navigate(settingsPath), openCard !== undefined)
  if (openCard && !isAllowed(openCard))
    return <p className="p-6 text-muted">Your workspace role does not give access to this page</p>
  if (openCard)
    return (
      <div className="flex flex-col gap-6 px-6 py-6 md:px-12 xl:px-16">
        <div className="flex items-center gap-2">
          <Link to={settingsPath} aria-label="Back to Workspace settings" className={iconButtonClass}>
            <ArrowLeft aria-hidden className="size-5" />
          </Link>
          <h1 className="text-2xl font-semibold">{openCard.title}</h1>
        </div>
        <openCard.Page
          workspaceId={workspaceId}
          isDexSignIn={isDexSignIn}
          instanceApps={authMode.instanceApps}
          permissions={permissions}
        />
      </div>
    )
  return (
    <div className="flex flex-col gap-8 px-6 py-6 md:px-12 xl:px-16">
      <h1 className="text-2xl font-semibold">Workspace settings</h1>
      <ChecklistBlock workspaceId={workspaceId} scope="workspace" usesSingleSignOn={!isDexSignIn} />
      {allowedSections.length > 0 ? (
        allowedSections.map(({ title, cards }) => (
          <LabelledSection key={title} title={title}>
            <ul className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
              {cards.map(({ path, title: cardTitle, description }) => (
                <li key={path}>
                  <Link
                    to={`${settingsPath}/${path}`}
                    aria-label={cardTitle}
                    aria-describedby={`settings-card-${path}`}
                    className={`flex h-full flex-col gap-1 rounded-lg border border-line bg-raised p-4 hover:bg-hover ${focusRing}`}
                  >
                    <span className="flex items-center justify-between gap-2 font-medium">
                      {cardTitle}
                      {path === 'costs' && budgetAlertCount > 0 && (
                        <span className="rounded-full bg-removed px-2 py-0.5 text-xs font-medium">
                          {countLabelOf(budgetAlertCount, 'budget alert')}
                        </span>
                      )}
                    </span>
                    <span id={`settings-card-${path}`} className="flex flex-1 flex-col gap-2 text-sm text-muted">
                      {description}
                      {statuses[path] && (path !== 'costs' || isMonthUsageComplete) && (
                        <span className="mt-auto text-xs text-ink">{statuses[path]}</span>
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
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
