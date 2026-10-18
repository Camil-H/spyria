import type { Snapshot } from '@hq/db'
import { useQuery } from '@hq/db/react'
import type { WorkspaceId } from '@hq/kernel'
import { WorkspaceConnectionsSection } from '@hq/profile'
import { RuntimeHostsSection } from '@hq/runtime'
import { focusRing, formatCost, iconButtonClass, LabelledSection } from '@hq/ui'
import { AuditLogSection, UsageSection } from '@hq/usage'
import { GitHubSection, MembersSection, RolesSection, SignInSection, useIsWorkspaceAdmin } from '@hq/workspace'
import { ArrowLeft } from 'lucide-react'
import { type ComponentType, use } from 'react'
import { Link, useOutletContext, useParams } from 'react-router'
import { loadAuthMode } from './auth.ts'

type SettingsCard = {
  path: string
  title: string
  description: string
  Page: ComponentType<{ workspaceId: WorkspaceId; isDexSignIn: boolean }>
}

const cardSections: readonly { title: string; cards: readonly SettingsCard[] }[] = [
  {
    title: 'Setup your organization',
    cards: [
      {
        path: 'sso',
        title: 'Setup SSO',
        description: 'Sign members in through your identity provider',
        Page: SignInSection,
      },
      {
        path: 'github',
        title: 'Connect GitHub',
        description: 'The GitHub App dev chats clone and push with',
        Page: GitHubSection,
      },
      { path: 'roles', title: 'Roles and Permissions', description: 'What each chat role allows', Page: RolesSection },
      { path: 'team', title: 'Manage Team', description: 'Members, workspace roles and invites', Page: MembersSection },
    ],
  },
  {
    title: 'Setup your agents',
    cards: [
      {
        path: 'runtime',
        title: 'Connect runtime',
        description: "Runtime hosts and members' own machines",
        Page: RuntimeHostsSection,
      },
      {
        path: 'mcp-tools',
        title: 'MCP tools',
        description: 'Tool servers shared with the workspace',
        Page: WorkspaceConnectionsSection,
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
        Page: UsageSection,
      },
      {
        path: 'audit',
        title: 'Audit log',
        description: 'Who changed what in the workspace, with tool calls and publishing',
        Page: AuditLogSection,
      },
    ],
  },
]

const authModeLoading = loadAuthMode()

const countLabelOf = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

const cardStatusesOf =
  (workspaceId: WorkspaceId, isDexSignIn: boolean) =>
  (snapshot: Snapshot): Readonly<Record<string, string>> => {
    const inWorkspace = <Row extends { workspaceId: WorkspaceId }>(rows: readonly Row[]) =>
      rows.filter((row) => row.workspaceId === workspaceId)
    const memberCount = inWorkspace(snapshot.memberships).filter((membership) => membership.removedAt === null).length
    const inviteCount = inWorkspace(snapshot.invitations).length
    const month = new Date().toISOString().slice(0, 7)
    const monthCostMicros = inWorkspace(snapshot.usageEntries)
      .filter((entry) => entry.month === month)
      .reduce((sum, entry) => sum + entry.costMicros, 0)
    return {
      ...(isDexSignIn && { sso: "Signs in with this deployment's Dex" }),
      roles: countLabelOf(inWorkspace(snapshot.chatRoles).filter((role) => role.builtIn).length, 'built-in role'),
      team: [countLabelOf(memberCount, 'member'), inviteCount > 0 && countLabelOf(inviteCount, 'pending invite')]
        .filter(Boolean)
        .join(' · '),
      runtime: countLabelOf(
        inWorkspace(snapshot.runtimeHosts).filter((host) => host.ownerId === null).length,
        'runtime host',
      ),
      'mcp-tools': countLabelOf(inWorkspace(snapshot.workspaceConnections).length, 'shared connection'),
      costs: `${formatCost(monthCostMicros)} this month`,
    }
  }

const SettingsRoute = () => {
  const workspaceId = useOutletContext<WorkspaceId>()
  const isAdmin = useIsWorkspaceAdmin(workspaceId)
  const isDexSignIn = use(authModeLoading) === 'dex'
  const statuses = useQuery(cardStatusesOf(workspaceId, isDexSignIn))
  const { card } = useParams()
  const openCard = cardSections.flatMap(({ cards }) => cards).find(({ path }) => path === card)
  const settingsPath = `/w/${workspaceId}/settings`
  if (isAdmin && openCard)
    return (
      <div className="flex max-w-3xl flex-col gap-6 p-6">
        <div className="flex items-center gap-2">
          <Link to={settingsPath} aria-label="Back to Workspace settings" className={iconButtonClass}>
            <ArrowLeft aria-hidden className="size-5" />
          </Link>
          <h1 className="text-2xl font-semibold">{openCard.title}</h1>
        </div>
        <openCard.Page workspaceId={workspaceId} isDexSignIn={isDexSignIn} />
      </div>
    )
  return (
    <div className="flex max-w-4xl flex-col gap-8 p-6">
      <h1 className="text-2xl font-semibold">Workspace settings</h1>
      {isAdmin ? (
        cardSections.map(({ title, cards }) => (
          <LabelledSection key={title} title={title}>
            <ul className="grid gap-3 sm:grid-cols-2">
              {cards.map(({ path, title: cardTitle, description }) => (
                <li key={path}>
                  <Link
                    to={`${settingsPath}/${path}`}
                    aria-label={cardTitle}
                    aria-describedby={`settings-card-${path}`}
                    className={`flex h-full flex-col gap-1 rounded-lg border border-line bg-raised p-4 hover:bg-hover ${focusRing}`}
                  >
                    <span className="font-medium">{cardTitle}</span>
                    <span id={`settings-card-${path}`} className="flex flex-1 flex-col gap-2 text-sm text-muted">
                      {description}
                      {statuses[path] && <span className="mt-auto text-xs text-ink">{statuses[path]}</span>}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </LabelledSection>
        ))
      ) : (
        <p className="text-muted">Only workspace admins can see this page</p>
      )}
    </div>
  )
}

export default SettingsRoute
