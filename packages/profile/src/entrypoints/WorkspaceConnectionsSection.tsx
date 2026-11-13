import { useQuery } from '@spyria/db/react'
import {
  type AccessLevel,
  accessLevels,
  builtInFeatures,
  builtInTools,
  type ConnectionTool,
  isAllowedAtLevel,
  type MemberId,
  ownValueOf,
  type ToolServerAccess,
  type WorkspaceId,
} from '@spyria/kernel'
import { useSession } from '@spyria/session'
import {
  buttonClass,
  cardClass,
  Dialog,
  dangerButtonClass,
  ErrorMessage,
  fieldClass,
  LabelledSection,
  labelClass,
  RowMenu,
  rowClass,
  StatusBadge,
  Switch,
  smallGhostButtonClass,
  useGuardedAction,
} from '@spyria/ui'
import { type ReactNode, type SubmitEvent, useState } from 'react'
import { Link } from 'react-router'
import {
  type AccessSubject,
  type ConnectionInput,
  type ConnectionSignIn,
  connectionSignIns,
} from '../domain/workspace-connection.ts'
import { getWorkspacePermissions } from '../queries/get-workspace-permissions.ts'
import {
  type ListedWorkspaceConnection,
  listGitHubToolAccess,
  listWorkspaceConnections,
  type ServerAccessList,
} from '../queries/list-workspace-connections.ts'
import { useProfileCommands } from './providers.tsx'
import { ToolList, toolCountsOf } from './ToolList.tsx'

type Editing = Pick<ListedWorkspaceConnection, 'name' | 'url' | 'headerName' | 'signIn'>

const signInLabels: Record<ConnectionSignIn, string> = {
  member: 'Each member signs in',
  shared: 'One shared login',
}

const levelLabels: Record<AccessLevel, string> = { none: 'None', read: 'Read', write: 'Read and write' }

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
              : 'Members connect their own account in their profile. You sign in once now so Spyria can list the tools.'}
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
        {connection ? 'Save' : 'Add server'}
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
}: {
  target: Target
  connection: ListedWorkspaceConnection
  onSaved?: () => void
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
      <span>
        <button type="button" className={buttonClass} disabled={isPending} onClick={save}>
          {connection.isReviewed ? 'Save' : 'Confirm'}
        </button>
      </span>
      <ErrorMessage message={errorMessage} />
    </section>
  )
}

const AccessRow = ({
  target,
  connection,
  subject,
  name,
  access,
  isNamedMember,
}: {
  target: Target
  connection: ServerAccessList
  subject: AccessSubject
  name: string
  access: ToolServerAccess | undefined
  isNamedMember?: boolean
}) => {
  const commands = useProfileCommands()
  const { errorMessage, isPending, run } = useGuardedAction()
  const [isListOpen, setIsListOpen] = useState(false)
  const level = access?.level ?? accessLevels.none
  const toolChanges = access?.toolChanges ?? {}
  const changeCount = Object.keys(toolChanges).length
  const isAllowed = (tool: ConnectionTool) => ownValueOf(toolChanges, tool.name) ?? isAllowedAtLevel(level, tool)
  const save = (changed: { level: AccessLevel | null; toolChanges?: Record<string, boolean> }) =>
    run(() => commands.setConnectionAccess({ ...target, ...subject, toolChanges: {}, ...changed }))
  const allowAll = (tools: readonly ConnectionTool[], isAllowedNow: boolean) =>
    save({ level, toolChanges: Object.fromEntries(tools.map(({ name }) => [name, isAllowedNow])) })
  return (
    <li aria-label={name} className="flex flex-col gap-2 py-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-32 flex-1">{name}</span>
        <select
          aria-label={`Access of ${name}`}
          className={fieldClass}
          disabled={isPending}
          value={level}
          onChange={(event) => save({ level: event.target.value as AccessLevel })}
        >
          {Object.values(accessLevels).map((option) => (
            <option key={option} value={option}>
              {levelLabels[option]}
            </option>
          ))}
        </select>
        <button type="button" className={smallGhostButtonClass} onClick={() => setIsListOpen(!isListOpen)}>
          {changeCount === 0 ? 'Single tools' : `${changeCount} single ${changeCount === 1 ? 'change' : 'changes'}`}
        </button>
        {isNamedMember && (
          <button
            type="button"
            className={smallGhostButtonClass}
            disabled={isPending}
            onClick={() => save({ level: null })}
          >
            Remove {name}
          </button>
        )}
      </div>
      {isListOpen && (
        <div className="rounded-md border border-line p-2">
          <ToolList
            label={`tools for ${name}`}
            tools={connection.tools}
            groupControlOf={(title, tools) => {
              const isEveryAllowed = tools.every(isAllowed)
              return (
                <Switch
                  label={`Allow all ${title.toLowerCase()}`}
                  isOn={isEveryAllowed}
                  onToggle={() => allowAll(tools, !isEveryAllowed)}
                />
              )
            }}
            controlOf={(tool) => (
              <input
                type="checkbox"
                aria-label={`${tool.name} for ${name}`}
                disabled={isPending}
                checked={isAllowed(tool)}
                onChange={() => save({ level, toolChanges: { [tool.name]: !isAllowed(tool) } })}
              />
            )}
          />
        </div>
      )}
      <ErrorMessage message={errorMessage} />
    </li>
  )
}

const ServerAccess = ({ target, connection }: { target: Target; connection: ServerAccessList }) => {
  const commands = useProfileCommands()
  const { errorMessage, isPending, run } = useGuardedAction()
  const addMember = (memberId: MemberId) =>
    run(() => commands.setConnectionAccess({ ...target, memberId, level: accessLevels.none, toolChanges: {} }))
  return (
    <section aria-label={`Access to ${connection.name}`} className="flex flex-col gap-1">
      <h4 className="text-xs font-semibold uppercase text-muted">Access</h4>
      <ul aria-label="Roles" className="flex flex-col divide-y divide-line">
        {connection.roles.map((role) => (
          <AccessRow
            key={role.id}
            target={target}
            connection={connection}
            subject={{ roleId: role.id }}
            name={role.name}
            access={role.access}
          />
        ))}
      </ul>
      {connection.namedMembers.length > 0 && (
        <ul aria-label="Named members" className="flex flex-col divide-y divide-line">
          {connection.namedMembers.map((member) => (
            <AccessRow
              key={member.id}
              target={target}
              connection={connection}
              subject={{ memberId: member.id }}
              name={member.name}
              access={member.access}
              isNamedMember
            />
          ))}
        </ul>
      )}
      {connection.otherMembers.length > 0 && (
        <label className={`${labelClass} w-fit`}>
          A member's own access replaces their role's
          <select
            className={fieldClass}
            disabled={isPending}
            value=""
            onChange={(event) => addMember(event.target.value as MemberId)}
          >
            <option value="">Add a member</option>
            {connection.otherMembers.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <ErrorMessage message={errorMessage} />
    </section>
  )
}

const serverCardClass = `${cardClass} flex flex-col text-sm`
const serverBodyClass = 'flex flex-col gap-4 px-4 py-3'

const ServerHeader = ({ name, status, children }: { name: string; status: ReactNode; children?: ReactNode }) => (
  <div className={`${rowClass} border-b border-line`}>
    <span className="font-medium">{name}</span>
    {status}
    {children}
  </div>
)

const connectionStatusOf = (connection: ListedWorkspaceConnection) => {
  if (connection.setupId !== null) return <StatusBadge tone="attention">Waiting for the sign-in</StatusBadge>
  if (!connection.isReviewed) return <StatusBadge tone="attention">To review</StatusBadge>
  return <StatusBadge tone="ok">{toolCountsOf(connection.tools)}</StatusBadge>
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
    <li aria-label={connection.name} className={serverCardClass}>
      <ServerHeader name={connection.name} status={connectionStatusOf(connection)}>
        <span className="min-w-0 flex-1 truncate text-muted" title={connection.url}>
          {signInSummaryOf(connection)}
        </span>
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
      </ServerHeader>
      <div className={serverBodyClass}>
        {connection.setupId !== null ? (
          <p className="text-muted">
            Waiting for the sign-in that lists its tools. If that window was closed, remove this server and add it
            again.
          </p>
        ) : (
          <>
            {(!connection.isReviewed || isCorrecting) && (
              <ToolMarkings target={target} connection={connection} onSaved={() => setIsCorrecting(false)} />
            )}
            {connection.isReviewed && <ServerAccess target={target} connection={connection} />}
          </>
        )}
        {!isRemoving && !isEditing && <ErrorMessage message={errorMessage} />}
      </div>
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
    </li>
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

const BuiltInTools = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const mayManageGitHub = useMayManageGitHub(workspaceId)
  return (
    <LabelledSection title="Built in">
      <p className="-mt-2 text-sm text-muted">
        Spyria's own tools, which every agent has. Nothing to set here: their settings live with their feature.
      </p>
      <section aria-label="Spyria" className={`${cardClass} text-sm`}>
        <ul aria-label="Built-in tools" className="grid md:grid-cols-2">
          {builtInTools.map((tool) => (
            <li key={tool.name} className="flex items-start justify-between gap-3 px-4 py-2.5">
              <span className="flex min-w-0 flex-col">
                <span className="font-mono text-xs">{tool.name}</span>
                <span className="text-xs text-muted">{tool.summary}</span>
              </span>
              {featureSettingOf(workspaceId, tool.feature, mayManageGitHub)}
            </li>
          ))}
        </ul>
      </section>
    </LabelledSection>
  )
}

const GitHubServerCard = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const github = useQuery(listGitHubToolAccess, workspaceId)
  const mayManageGitHub = useMayManageGitHub(workspaceId)
  const [isListOpen, setIsListOpen] = useState(false)
  return (
    <li aria-label={github.name} className={serverCardClass}>
      <ServerHeader name={github.name} status={<StatusBadge tone="ok">{toolCountsOf(github.tools)}</StatusBadge>}>
        <span className="min-w-0 flex-1 truncate text-muted">Built in · {signInLabels.member}</span>
        <SettingsCardLink to={`/w/${workspaceId}/settings/github`} isAllowed={mayManageGitHub}>
          Set up in GitHub
        </SettingsCardLink>
      </ServerHeader>
      <div className={serverBodyClass}>
        <button
          type="button"
          aria-expanded={isListOpen}
          className={`self-start ${smallGhostButtonClass}`}
          onClick={() => setIsListOpen(!isListOpen)}
        >
          What each tool does
        </button>
        {isListOpen && <ToolList label={`${github.name} tools`} tools={github.tools} controlOf={() => null} />}
        <ServerAccess target={{ workspaceId, connectionId: github.id }} connection={github} />
      </div>
    </li>
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
    <div className="flex flex-col gap-10">
      <LabelledSection title="Servers">
        <div className="-mt-2 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">The tool servers agents may call, and what each role may use</p>
          <button type="button" className={buttonClass} onClick={() => setIsAdding(true)}>
            Add server
          </button>
        </div>
        <ul aria-label="Servers" className="flex flex-col gap-4">
          <GitHubServerCard workspaceId={workspaceId} />
          {connections.map((connection) => (
            <ConnectionCard key={connection.id} workspaceId={workspaceId} connection={connection} />
          ))}
        </ul>
        {isAdding && <AddServerDialog workspaceId={workspaceId} onClose={() => setIsAdding(false)} />}
      </LabelledSection>
      <BuiltInTools workspaceId={workspaceId} />
    </div>
  )
}
