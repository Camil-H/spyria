import { useQuery } from '@hq/db'
import { getMembers } from '../queries/get-members.ts'
import { LabelList } from './LabelList.tsx'
import type { TabProps } from './TabProps.ts'

export const MembersTab = ({ workspaceId, chatId }: TabProps) => {
  const members = useQuery(getMembers(workspaceId, chatId))
  return (
    <LabelList
      emptyMessage="No members"
      rows={members.map((member) => ({ key: member.memberId, label: member.name, value: member.role }))}
    />
  )
}
