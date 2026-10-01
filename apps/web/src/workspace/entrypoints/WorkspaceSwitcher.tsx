import { useQuery } from '@hq/db'
import type { WorkspaceId } from '@hq/kernel'
import { Content, Item, Root, Trigger } from '@radix-ui/react-dropdown-menu'
import { useNavigate } from 'react-router'
import { useSession } from '../../app/session.tsx'
import { listWorkspaces } from '../queries/list-workspaces.ts'

export const WorkspaceSwitcher = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const navigate = useNavigate()
  const workspaces = useQuery(listWorkspaces(useSession().memberId))
  return (
    <Root>
      <Trigger aria-label="Switch workspace">
        {workspaces.find((workspace) => workspace.id === workspaceId)?.name}
      </Trigger>
      <Content>
        {workspaces.map((workspace) => (
          <Item key={workspace.id} onSelect={() => navigate(`/w/${workspace.id}`)}>
            {workspace.name}
          </Item>
        ))}
      </Content>
    </Root>
  )
}
