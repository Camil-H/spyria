import { useQuery } from '@spyria/db/react'
import type { MemberId, WorkspaceId } from '@spyria/kernel'
import {
  buttonClass,
  Dialog,
  ErrorMessage,
  fieldClass,
  ghostButtonClass,
  LabelledSection,
  labelClass,
  useGuardedAction,
} from '@spyria/ui'
import { type SubmitEvent, useState } from 'react'
import { type ConnectionInput, type ConnectionSignIn, connectionSignIns } from '../domain/workspace-connection.ts'
import { type ListedWorkspaceConnection, listWorkspaceConnections } from '../queries/list-workspace-connections.ts'
import { useProfileCommands } from './providers.tsx'

type Editing = Pick<ListedWorkspaceConnection, 'name' | 'url' | 'headerName' | 'signIn'>

const signInLabels: Record<ConnectionSignIn, string> = {
  member: 'Each member signs in',
  shared: 'One shared login',
}

const toggled = (tools: readonly string[], tool: string) =>
  tools.includes(tool) ? tools.filter((name) => name !== tool) : [...tools, tool]

const ConnectionForm = ({
  label,
  connection,
  onSubmit,
  onCancel,
}: {
  label: string
  connection?: Editing
  onSubmit: (input: ConnectionInput) => Promise<boolean>
  onCancel?: () => void
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
    <form aria-label={label} onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <label className={`${labelClass} min-w-32 flex-1`}>
        Name
        <input className={fieldClass} value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className={`${labelClass} min-w-56 flex-[2]`}>
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
        <fieldset className="flex basis-full flex-wrap gap-x-4 gap-y-1 text-sm">
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
          <label className={`${labelClass} min-w-32 flex-1`}>
            Secret header
            <input
              className={fieldClass}
              placeholder="x-api-key"
              value={headerName}
              onChange={(event) => setHeaderName(event.target.value)}
            />
          </label>
          <label className={`${labelClass} min-w-32 flex-1`}>
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
      <button type="submit" className={buttonClass} disabled={name.trim() === '' || url.trim() === ''}>
        {connection ? 'Save' : 'Add server'}
      </button>
      {onCancel && (
        <button type="button" className={ghostButtonClass} onClick={onCancel}>
          Cancel
        </button>
      )}
      {connection && (
        <p className="basis-full text-xs text-muted">
          {isShared
            ? 'A new address registers the server again in the gateway: enter the secret value again.'
            : 'Members sign in at this address: remove the server and add it again to change it.'}
        </p>
      )}
    </form>
  )
}

const signInSummaryOf = ({ signIn, headerName }: Editing) =>
  signIn === connectionSignIns.member
    ? signInLabels.member
    : `${signInLabels.shared}${headerName ? `, ${headerName}: set` : ''}`

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
  const target = { workspaceId, connectionId: connection.id }
  const allowTools = (allowedTools: string[]) => run(() => commands.allowConnectionTools({ ...target, allowedTools }))
  const restrict = (memberId: MemberId, tools: string[]) =>
    run(() =>
      commands.restrictConnectionMember({
        ...target,
        memberId,
        allowedTools: tools.length === connection.allowedTools.length ? null : tools,
      }),
    )
  return (
    <li aria-label={connection.name} className="flex flex-col gap-3 rounded-lg border border-line p-3 text-sm">
      {isEditing ? (
        <ConnectionForm
          label={`Edit ${connection.name}`}
          connection={connection}
          onCancel={() => setIsEditing(false)}
          onSubmit={async (input) => {
            const isSaved = await run(() => commands.editWorkspaceConnection({ ...target, ...input }))
            if (isSaved) setIsEditing(false)
            return isSaved
          }}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-medium">{connection.name}</span>
          <span className="truncate text-muted">{connection.url}</span>
          <span className="text-muted">{signInSummaryOf(connection)}</span>
          <span className="ml-auto flex gap-2">
            <button type="button" className={ghostButtonClass} onClick={() => setIsEditing(true)}>
              Edit
            </button>
            <button type="button" className={ghostButtonClass} onClick={() => setIsRemoving(true)}>
              Remove
            </button>
          </span>
        </div>
      )}
      {connection.setupId === null ? (
        <>
          <fieldset aria-label={`Tools of ${connection.name}`} className="flex flex-wrap gap-x-4 gap-y-1">
            <legend className="mb-1 text-xs font-semibold uppercase text-muted">Allowed tools</legend>
            {connection.tools.map((tool) => (
              <label key={tool.name} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  disabled={isPending}
                  checked={connection.allowedTools.includes(tool.name)}
                  onChange={() => allowTools(toggled(connection.allowedTools, tool.name))}
                />
                {tool.name}
                <span className="text-xs text-muted">{tool.readOnly ? 'read-only' : 'writes'}</span>
              </label>
            ))}
          </fieldset>
          <table aria-label={`Member access to ${connection.name}`} className="text-left">
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-1 font-semibold uppercase">Member access</th>
                {connection.allowedTools.map((tool) => (
                  <th key={tool} className="px-2 py-1 font-normal">
                    {tool}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {connection.members.map((member) => (
                <tr key={member.id}>
                  <td className="py-1">{member.name}</td>
                  {connection.allowedTools.map((tool) => (
                    <td key={tool} className="px-2 py-1">
                      <input
                        type="checkbox"
                        aria-label={`${tool} for ${member.name}`}
                        disabled={isPending}
                        checked={member.tools.includes(tool)}
                        onChange={() => restrict(member.id, toggled(member.tools, tool))}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <p className="text-muted">The sign-in that lists its tools was not finished: remove it and add it again.</p>
      )}
      {!isRemoving && <ErrorMessage message={errorMessage} />}
      {isRemoving && (
        <Dialog label="Remove server" subject={connection.name} onClose={() => setIsRemoving(false)}>
          <p className="text-sm text-muted">Agents lose its tools at once, in every chat of this workspace.</p>
          <ErrorMessage message={errorMessage} />
          <button
            type="button"
            className={buttonClass}
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

export const WorkspaceConnectionsSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useProfileCommands()
  const connections = useQuery(listWorkspaceConnections, workspaceId)
  const { errorMessage, isPending, run } = useGuardedAction()
  return (
    <LabelledSection title="Servers">
      {connections.length === 0 ? (
        <p className="text-sm text-muted">No servers yet</p>
      ) : (
        <ul aria-label="Servers" className="flex flex-col gap-3">
          {connections.map((connection) => (
            <ConnectionCard key={connection.id} workspaceId={workspaceId} connection={connection} />
          ))}
        </ul>
      )}
      <ConnectionForm
        label="Add server"
        onSubmit={(input) => run(() => commands.addWorkspaceConnection({ workspaceId, ...input }))}
      />
      {isPending && <p className="text-sm text-muted">Listing the server's tools…</p>}
      <ErrorMessage message={errorMessage} />
    </LabelledSection>
  )
}
