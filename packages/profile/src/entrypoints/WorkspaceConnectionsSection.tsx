import { useQuery } from '@spyria/db/react'
import { builtInFeatures, builtInTools, type WorkspaceId } from '@spyria/kernel'
import { useSession } from '@spyria/session'
import {
  buttonClass,
  cardClass,
  Dialog,
  dangerButtonClass,
  ErrorMessage,
  fieldClass,
  focusRing,
  ghostButtonClass,
  LabelledSection,
  labelClass,
  overlineClass,
  RowMenu,
  rowClass,
  StatusBadge,
  useGuardedAction,
} from '@spyria/ui'
import { ChevronRight } from 'lucide-react'
import { type ReactNode, type SubmitEvent, useState } from 'react'
import { Link } from 'react-router'
import { type ConnectionInput, type ConnectionSignIn, connectionSignIns } from '../domain/workspace-connection.ts'
import { getWorkspacePermissions } from '../queries/get-workspace-permissions.ts'
import {
  type ListedWorkspaceConnection,
  listGitHubToolAccess,
  listToolRoles,
  listWorkspaceConnections,
} from '../queries/list-workspace-connections.ts'
import { useProfileCommands } from './providers.tsx'
import { AllToolsCheckbox, RoleHeading, ServerAccessGrid } from './ServerAccessGrid.tsx'
import { ToolList, toolCountsOf } from './ToolList.tsx'
import { ToolTable } from './ToolTable.tsx'

type Editing = Pick<ListedWorkspaceConnection, 'name' | 'url' | 'headerName' | 'signIn'>

const signInLabels: Record<ConnectionSignIn, string> = {
  member: 'Each member signs in',
  shared: 'One shared login',
}

const ConnectionForm = ({
  label,
  connection,
  isPending,
  onSubmit,
}: {
  label: string
  connection?: Editing
  isPending: boolean
  onSubmit: (input: ConnectionInput) => Promise<boolean>
}) => {
  const [name, setName] = useState(connection?.name ?? '')
  const [url, setUrl] = useState(connection?.url ?? '')
  const [signIn, setSignIn] = useState<ConnectionSignIn>(connection?.signIn ?? connectionSignIns.member)
  const [headerName, setHeaderName] = useState(connection?.headerName ?? '')
  const [headerValue, setHeaderValue] = useState('')
  const isShared = signIn === connectionSignIns.shared
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const isHeaderRemoved = connection?.headerName && headerName.trim() === ''
    const secretHeader =
      isShared && headerValue ? { name: headerName.trim(), value: headerValue } : isHeaderRemoved ? null : undefined
    if ((await onSubmit({ name, url, signIn, secretHeader })) && !connection) {
      setName('')
      setUrl('')
      setHeaderName('')
    }
    setHeaderValue('')
  }
  return (
    <form aria-label={label} onSubmit={submit} className="flex flex-col gap-3">
      <label className={labelClass}>
        Name
        <input className={fieldClass} value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className={labelClass}>
        Address
        <input
          type="url"
          className={fieldClass}
          placeholder="https://tools.example.com/mcp"
          disabled={connection?.signIn === connectionSignIns.member}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      {!connection && (
        <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <legend className={labelClass}>Sign-in</legend>
          {Object.values(connectionSignIns).map((mode) => (
            <label key={mode} className="flex items-center gap-1.5">
              <input type="radio" name="sign-in" checked={signIn === mode} onChange={() => setSignIn(mode)} />
              {signInLabels[mode]}
            </label>
          ))}
          <p className="basis-full text-xs text-muted">
            {isShared
              ? 'Every member uses the login you enter here: only for servers without their own sign-in, such as API-key or internal servers.'
              : 'A sign-in window opens: you sign in once so Spyria can list the tools. Members then connect their own account in their profile.'}
          </p>
        </fieldset>
      )}
      {isShared && (
        <>
          <label className={labelClass}>
            Secret header
            <input
              className={fieldClass}
              placeholder="x-api-key"
              value={headerName}
              onChange={(event) => setHeaderName(event.target.value)}
            />
          </label>
          <label className={labelClass}>
            Secret value
            <input
              type="password"
              autoComplete="off"
              className={fieldClass}
              placeholder={connection?.headerName ? 'Set (leave blank to keep)' : ''}
              value={headerValue}
              onChange={(event) => setHeaderValue(event.target.value)}
            />
          </label>
        </>
      )}
      {connection && (
        <p className="text-xs text-muted">
          {isShared
            ? 'A new address registers the server again in the gateway: enter the secret value again.'
            : 'Members sign in at this address: remove the server and add it again to change it.'}
        </p>
      )}
      <button type="submit" className={buttonClass} disabled={isPending || name.trim() === '' || url.trim() === ''}>
        {connection ? 'Save' : isShared ? 'Add server' : 'Sign in and add server'}
      </button>
    </form>
  )
}

const signInSummaryOf = ({ signIn, headerName }: Editing) =>
  signIn === connectionSignIns.member
    ? signInLabels.member
    : `${signInLabels.shared}${headerName ? `, ${headerName}: set` : ''}`

type Target = { workspaceId: WorkspaceId; connectionId: string }

const ToolMarkings = ({
  target,
  connection,
  onSaved,
  onCancel,
}: {
  target: Target
  connection: ListedWorkspaceConnection
  onSaved?: () => void
  onCancel?: () => void
}) => {
  const commands = useProfileCommands()
  const { errorMessage, isPending, run } = useGuardedAction()
  const [readOnlyByTool, setReadOnlyByTool] = useState(
    () => new Map(connection.tools.map((tool) => [tool.name, tool.readOnly])),
  )
  const marked = connection.tools.map((tool) => ({ ...tool, readOnly: readOnlyByTool.get(tool.name) ?? tool.readOnly }))
  const mark = (tool: string, readOnly: boolean) => setReadOnlyByTool((current) => new Map(current).set(tool, readOnly))
  const save = async () => {
    const markings = marked.map(({ name, readOnly }) => ({ name, readOnly }))
    if (await run(() => commands.reviewConnectionTools({ ...target, markings }))) onSaved?.()
  }
  return (
    <section aria-label={`Read and write of ${connection.name}`} className="flex flex-col gap-2">
      <p className="text-muted">
        {connection.isReviewed
          ? 'Correct what each tool does: Read levels give only the tools marked read.'
          : 'Check what each tool does, as servers can mark it wrongly. Members get this server once you confirm.'}
      </p>
      <ToolList
        label={`${connection.name} tools`}
        tools={marked}
        controlOf={(tool) => (
          <select
            aria-label={`What ${tool.name} does`}
            className={fieldClass}
            value={tool.readOnly ? 'read' : 'write'}
            onChange={(event) => mark(tool.name, event.target.value === 'read')}
          >
            <option value="read">Only reads</option>
            <option value="write">Writes</option>
          </select>
        )}
      />
      <span className="flex gap-2">
        <button type="button" className={buttonClass} disabled={isPending} onClick={save}>
          {connection.isReviewed ? 'Save' : 'Confirm'}
        </button>
        {onCancel && (
          <button type="button" className={ghostButtonClass} onClick={onCancel}>
            Cancel
          </button>
        )}
      </span>
      <ErrorMessage message={errorMessage} />
    </section>
  )
}

const serverCardClass = `${cardClass} flex flex-col text-sm`
const serverBodyClass = 'flex flex-col gap-4 px-4 py-3'

const ServerCard = ({
  name,
  status,
  summary,
  needsAttention = false,
  actions,
  dialogs,
  children,
}: {
  name: string
  status: ReactNode
  summary: string
  needsAttention?: boolean
  actions?: ReactNode
  dialogs?: ReactNode
  children: ReactNode
}) => {
  const [isOpen, setIsOpen] = useState(needsAttention)
  const [neededAttention, setNeededAttention] = useState(needsAttention)
  if (needsAttention !== neededAttention) {
    setNeededAttention(needsAttention)
    if (needsAttention) setIsOpen(true)
  }
  return (
    <li aria-label={name} className={serverCardClass}>
      <div className={`${rowClass} gap-2 ${isOpen ? 'border-b border-line' : ''}`}>
        <button
          type="button"
          aria-expanded={isOpen}
          onClick={() => setIsOpen(!isOpen)}
          className={`flex min-w-0 flex-1 items-center gap-3 rounded-md text-left ${focusRing} aria-expanded:[&>svg:first-child]:rotate-90`}
        >
          <ChevronRight aria-hidden className="size-4 shrink-0 text-muted transition-transform" />
          <span className="font-medium">{name}</span>
          {status}
          <span className="min-w-0 flex-1 truncate text-muted" title={summary}>
            {summary}
          </span>
        </button>
        {actions}
      </div>
      {isOpen && <div className={serverBodyClass}>{children}</div>}
      {dialogs}
    </li>
  )
}

const connectionStatusOf = (connection: ListedWorkspaceConnection) => {
  if (connection.setupId !== null) return <StatusBadge tone="attention">Waiting for the sign-in</StatusBadge>
  return (
    <StatusBadge tone={connection.isReviewed ? 'ok' : 'attention'}>
      {connection.isReviewed ? toolCountsOf(connection.tools) : `To review · ${toolCountsOf(connection.tools)}`}
    </StatusBadge>
  )
}

const ConnectionCard = ({
  workspaceId,
  connection,
}: {
  workspaceId: WorkspaceId
  connection: ListedWorkspaceConnection
}) => {
  const commands = useProfileCommands()
  const { errorMessage, isPending, run } = useGuardedAction()
  const [isEditing, setIsEditing] = useState(false)
  const [isRemoving, setIsRemoving] = useState(false)
  const [isCorrecting, setIsCorrecting] = useState(false)
  const target = { workspaceId, connectionId: connection.id }
  return (
    <ServerCard
      name={connection.name}
      status={connectionStatusOf(connection)}
      summary={`${signInSummaryOf(connection)} · ${connection.url}`}
      needsAttention={!connection.isReviewed || connection.setupId !== null || isCorrecting}
      actions={
        <RowMenu
          label={`Actions for ${connection.name}`}
          items={[
            { label: 'Edit', onSelect: () => setIsEditing(true) },
            ...(connection.isReviewed && connection.setupId === null
              ? [{ label: 'Correct read and write', onSelect: () => setIsCorrecting(true) }]
              : []),
            { label: 'Remove', onSelect: () => setIsRemoving(true) },
          ]}
        />
      }
      dialogs={
        <>
          {isEditing && (
            <Dialog label={`Edit ${connection.name}`} isWide onClose={() => setIsEditing(false)}>
              <ConnectionForm
                label={`Edit ${connection.name}`}
                connection={connection}
                isPending={isPending}
                onSubmit={async (input) => {
                  const isSaved = await run(() => commands.editWorkspaceConnection({ ...target, ...input }))
                  if (isSaved) setIsEditing(false)
                  return isSaved
                }}
              />
              <ErrorMessage message={errorMessage} />
            </Dialog>
          )}
          {isRemoving && (
            <Dialog label="Remove server" subject={connection.name} onClose={() => setIsRemoving(false)}>
              <p className="text-sm text-muted">Agents lose its tools at once, in every chat of this workspace.</p>
              <ErrorMessage message={errorMessage} />
              <button
                type="button"
                className={dangerButtonClass}
                disabled={isPending}
                onClick={() => run(() => commands.removeWorkspaceConnection(target))}
              >
                Remove
              </button>
            </Dialog>
          )}
        </>
      }
    >
      {connection.setupId !== null ? (
        <p className="text-muted">
          Waiting for the sign-in that lists its tools. If that window was closed, remove this server and add it again.
        </p>
      ) : (
        <>
          {(!connection.isReviewed || isCorrecting) && (
            <ToolMarkings
              target={target}
              connection={connection}
              onSaved={() => setIsCorrecting(false)}
              onCancel={connection.isReviewed ? () => setIsCorrecting(false) : undefined}
            />
          )}
          {connection.isReviewed && <ServerAccessGrid target={target} connection={connection} />}
        </>
      )}
      {!isRemoving && !isEditing && <ErrorMessage message={errorMessage} />}
    </ServerCard>
  )
}

const useMayManageGitHub = (workspaceId: WorkspaceId) =>
  useQuery(getWorkspacePermissions, workspaceId, useSession().memberId).includes('github.manage')

const SettingsCardLink = ({ to, isAllowed, children }: { to: string; isAllowed: boolean; children: ReactNode }) =>
  isAllowed ? (
    <Link to={to} className="text-ink underline">
      {children}
    </Link>
  ) : (
    <span className="text-muted">{children}</span>
  )

const featureSettingOf = (workspaceId: WorkspaceId, feature: string | null, mayManageGitHub: boolean) => {
  if (feature === builtInFeatures.qualityGates)
    return (
      <span className="text-xs">
        <SettingsCardLink to={`/w/${workspaceId}/settings/quality-gates`} isAllowed={mayManageGitHub}>
          Set in Quality gates
        </SettingsCardLink>
      </span>
    )
  if (feature === builtInFeatures.browser) return <span className="text-xs text-muted">Shown in the Browser tab</span>
  return null
}

const BuiltInToolsCard = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const mayManageGitHub = useMayManageGitHub(workspaceId)
  const roles = useQuery(listToolRoles, workspaceId)
  return (
    <ServerCard
      name="Spyria"
      status={<StatusBadge tone="ok">{toolCountsOf(builtInTools)}</StatusBadge>}
      summary="Built in · every role has them"
    >
      <section aria-label="Access to Spyria" className="flex flex-col gap-3">
        <h4 className={overlineClass}>Access by role</h4>
        <ToolTable
          serverName="Spyria"
          tools={builtInTools}
          detailOf={(tool) => featureSettingOf(workspaceId, tool.feature, mayManageGitHub)}
          columns={roles.map((role) => ({
            key: role.id,
            heading: (shownTools, kind) => (
              <RoleHeading name={role.name}>
                <AllToolsCheckbox
                  label={`All ${kind.toLowerCase()} tools shown for ${role.name}, always given`}
                  allowedCount={shownTools.length}
                  toolCount={shownTools.length}
                  disabled
                />
              </RoleHeading>
            ),
            cell: (tool) => (
              <input type="checkbox" aria-label={`${tool.name} for ${role.name}, always given`} checked disabled />
            ),
          }))}
        />
      </section>
    </ServerCard>
  )
}

const GitHubServerCard = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const github = useQuery(listGitHubToolAccess, workspaceId)
  const mayManageGitHub = useMayManageGitHub(workspaceId)
  return (
    <ServerCard
      name={github.name}
      status={<StatusBadge tone="ok">{toolCountsOf(github.tools)}</StatusBadge>}
      summary={`Built in · ${signInLabels.member}`}
      actions={
        <SettingsCardLink to={`/w/${workspaceId}/settings/github`} isAllowed={mayManageGitHub}>
          Set up in GitHub
        </SettingsCardLink>
      }
    >
      <ServerAccessGrid target={{ workspaceId, connectionId: github.id }} connection={github} />
    </ServerCard>
  )
}

const AddServerDialog = ({ workspaceId, onClose }: { workspaceId: WorkspaceId; onClose: () => void }) => {
  const commands = useProfileCommands()
  const { errorMessage, isPending, run } = useGuardedAction()
  return (
    <Dialog label="Add server" isWide onClose={onClose}>
      <ConnectionForm
        label="Add server"
        isPending={isPending}
        onSubmit={async (input) => {
          const isAdded = await run(() => commands.addWorkspaceConnection({ workspaceId, ...input }))
          if (isAdded) onClose()
          return isAdded
        }}
      />
      {isPending && <p className="text-sm text-muted">Listing the server's tools…</p>}
      <ErrorMessage message={errorMessage} />
    </Dialog>
  )
}

export const WorkspaceConnectionsSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const connections = useQuery(listWorkspaceConnections, workspaceId)
  const [isAdding, setIsAdding] = useState(false)
  return (
    <LabelledSection title="Servers">
      <div className="-mt-2 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">The tool servers agents may call, and what each role may use</p>
        <button type="button" className={buttonClass} onClick={() => setIsAdding(true)}>
          Add server
        </button>
      </div>
      <ul aria-label="Servers" className="flex flex-col gap-3">
        <BuiltInToolsCard workspaceId={workspaceId} />
        <GitHubServerCard workspaceId={workspaceId} />
        {connections.map((connection) => (
          <ConnectionCard key={connection.id} workspaceId={workspaceId} connection={connection} />
        ))}
      </ul>
      {isAdding && <AddServerDialog workspaceId={workspaceId} onClose={() => setIsAdding(false)} />}
    </LabelledSection>
  )
}
