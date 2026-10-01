import { useQuery } from '@hq/db'
import type { WorkspaceId } from '@hq/kernel'
import { Content, Item, Root, Trigger } from '@radix-ui/react-dropdown-menu'
import { useNavigate } from 'react-router'
import { useSession } from '../../app/session.tsx'
import { listWorkspaces } from '../queries/list-workspaces.ts'
import { focusRing, menuContentClass, menuItemClass } from './ui.ts'

export const WorkspaceSwitcher = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const navigate = useNavigate()
  const workspaces = useQuery(listWorkspaces(useSession().memberId))
  return (
    <Root>
      <Trigger
        aria-label="Switch workspace"
        className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left font-semibold hover:bg-hover data-[state=open]:bg-hover ${focusRing}`}
      >
        {workspaces.find((workspace) => workspace.id === workspaceId)?.name}
      </Trigger>
      <Content align="start" sideOffset={4} className={menuContentClass}>
        {workspaces.map((workspace) => (
          <Item className={menuItemClass} key={workspace.id} onSelect={() => navigate(`/w/${workspace.id}`)}>
            {workspace.name}
          </Item>
        ))}
      </Content>
    </Root>
  )
}
