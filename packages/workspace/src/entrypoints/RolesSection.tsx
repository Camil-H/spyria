import { useQuery } from '@hq/db/react'
import type { ChatPermission, WorkspaceId } from '@hq/kernel'
import { LabelledSection } from '@hq/ui'
import { listBuiltInChatRoles } from '../queries/list-chat-roles.ts'

const permissionLabels: Record<ChatPermission, string> = {
  'chat.read': 'Read the chat',
  'chat.post': 'Post and prompt the agent',
  'session.configure': 'Choose the model and stop the agent',
  'tools.manage': "Manage the chat's tools",
  'members.invite': 'Invite people to the chat',
  'members.manage': 'Change roles and remove people',
  'chat.admin': 'Rename, move and archive the chat, change its visibility',
}

export const RolesSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const roles = useQuery(listBuiltInChatRoles(workspaceId))
  return (
    <LabelledSection title="Chat roles">
      <p className="text-sm text-muted">Each chat gives its people one of these roles. Custom roles come later.</p>
      <ul aria-label="Chat roles" className="flex flex-col gap-3">
        {roles.map((role) => (
          <li key={role.id} aria-label={role.name} className="rounded-lg border border-line p-3">
            <h3 className="font-medium">{role.name}</h3>
            <ul className="mt-1 list-disc pl-5 text-sm text-muted">
              {role.permissions.map((permission) => (
                <li key={permission}>{permissionLabels[permission]}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </LabelledSection>
  )
}
