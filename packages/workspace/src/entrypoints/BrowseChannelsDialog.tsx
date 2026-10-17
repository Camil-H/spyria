import type { WorkspaceId } from '@hq/kernel'
import { Dialog, ErrorMessage, ghostButtonClass, useGuardedAction } from '@hq/ui'
import { Link } from 'react-router'
import type { JoinableChannel } from '../queries/list-joinable-channels.ts'
import { useWorkspaceCommands } from './providers.tsx'

const BrowseChannelsDialog = ({
  workspaceId,
  channels,
  onClose,
}: {
  workspaceId: WorkspaceId
  channels: readonly JoinableChannel[]
  onClose: () => void
}) => {
  const commands = useWorkspaceCommands()
  const { errorMessage, isPending, run } = useGuardedAction()
  return (
    <Dialog label="Browse channels" closeLabel="Close" onClose={onClose}>
      {channels.length === 0 ? (
        <p className="text-sm text-muted">No channels to join</p>
      ) : (
        <ul className="-mx-2 flex max-h-80 flex-col overflow-y-auto">
          {channels.map((channel) => (
            <li
              key={channel.id}
              aria-label={channel.name}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-hover"
            >
              <Link to={`/w/${workspaceId}/chats/${channel.id}`} onClick={onClose} className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium"># {channel.name}</span>
                <span className="block truncate text-xs text-muted">
                  {[channel.projectName, `${channel.memberCount} ${channel.memberCount === 1 ? 'member' : 'members'}`]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </Link>
              <button
                type="button"
                className={ghostButtonClass}
                disabled={isPending}
                onClick={() => run(() => commands.joinChannel({ workspaceId, chatId: channel.id }))}
              >
                Join
              </button>
            </li>
          ))}
        </ul>
      )}
      <ErrorMessage message={errorMessage} />
    </Dialog>
  )
}

export default BrowseChannelsDialog
