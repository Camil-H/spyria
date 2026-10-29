import type { WorkspaceId } from '@spyria/kernel'
import { chatTypeIconOf, Dialog, ErrorMessage, fieldClass, ghostButtonClass, useGuardedAction } from '@spyria/ui'
import { useState } from 'react'
import { Link } from 'react-router'
import type { JoinableChat } from '../queries/list-joinable-chats.ts'
import { useWorkspaceCommands } from './providers.tsx'

const BrowseChatsDialog = ({
  workspaceId,
  chats,
  onClose,
}: {
  workspaceId: WorkspaceId
  chats: readonly JoinableChat[]
  onClose: () => void
}) => {
  const commands = useWorkspaceCommands()
  const { errorMessage, isPending, run } = useGuardedAction()
  const [search, setSearch] = useState('')
  const searched = search.trim().toLowerCase()
  const matchingChats = chats.filter((chat) =>
    [chat.name, chat.projectName ?? ''].some((text) => text.toLowerCase().includes(searched)),
  )
  return (
    <Dialog label="Browse public chats" closeLabel="Close" onClose={onClose}>
      {chats.length === 0 ? (
        <p className="text-sm text-muted">No chats to join</p>
      ) : (
        <>
          <input
            type="search"
            aria-label="Search chats"
            placeholder="Search by chat or project"
            className={fieldClass}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {matchingChats.length === 0 && <p className="text-sm text-muted">No chats match “{search.trim()}”</p>}
        </>
      )}
      {matchingChats.length > 0 && (
        <ul className="-mx-2 flex max-h-80 flex-col overflow-y-auto">
          {matchingChats.map((chat) => {
            const { Icon, label } = chatTypeIconOf(chat.type)
            return (
              <li
                key={chat.id}
                aria-label={chat.name}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-hover"
              >
                <Link to={`/w/${workspaceId}/chats/${chat.id}`} onClick={onClose} className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <Icon aria-label={label} role="img" size={14} className="shrink-0" />
                    <span className="truncate">{chat.name}</span>
                  </span>
                  <span className="block truncate text-xs text-muted">
                    {[chat.projectName, `${chat.memberCount} ${chat.memberCount === 1 ? 'member' : 'members'}`]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </Link>
                <button
                  type="button"
                  className={ghostButtonClass}
                  disabled={isPending}
                  onClick={() => run(() => commands.joinChat({ workspaceId, chatId: chat.id }))}
                >
                  Join
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <ErrorMessage message={errorMessage} />
    </Dialog>
  )
}

export default BrowseChatsDialog
