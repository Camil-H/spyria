import { Content, List, Root, Trigger } from '@radix-ui/react-tabs'
import type { WorkspaceId, WorkspacePermission } from '@spyria/kernel'
import { tabTriggerClass } from '@spyria/ui'
import type { ComponentType } from 'react'
import { MembersSection } from './MembersSection.tsx'
import { RolesSection } from './RolesSection.tsx'

const tabs = [
  { title: 'Members', permissions: ['members.invite', 'members.manage'] as const, Section: MembersSection },
  { title: 'Roles', permissions: ['roles.manage'] as const, Section: RolesSection },
] satisfies readonly {
  title: string
  permissions: readonly WorkspacePermission[]
  Section: ComponentType<{ workspaceId: WorkspaceId }>
}[]

export const MembersAndRolesSection = ({
  workspaceId,
  permissions,
}: {
  workspaceId: WorkspaceId
  permissions: readonly WorkspacePermission[]
}) => {
  const allowedTabs = tabs.filter((tab) => tab.permissions.some((permission) => permissions.includes(permission)))
  const [firstTab] = allowedTabs
  if (!firstTab) return null
  if (allowedTabs.length === 1) return <firstTab.Section workspaceId={workspaceId} />
  return (
    <Root defaultValue={firstTab.title} className="flex flex-col gap-6">
      <List aria-label="Members and roles" className="flex gap-4 border-b border-line">
        {allowedTabs.map(({ title }) => (
          <Trigger key={title} value={title} className={tabTriggerClass}>
            {title}
          </Trigger>
        ))}
      </List>
      {allowedTabs.map(({ title, Section }) => (
        <Content key={title} value={title}>
          <Section workspaceId={workspaceId} />
        </Content>
      ))}
    </Root>
  )
}
