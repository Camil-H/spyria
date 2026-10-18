import { useQuery } from '@hq/db/react'
import { BookOpen } from 'lucide-react'
import { getSources } from '../queries/get-sources.ts'
import { EmptyState } from './EmptyState.tsx'
import { LabelList } from './LabelList.tsx'
import type { TabProps } from './TabProps.ts'

const SourcesTab = ({ workspaceId, chatId }: TabProps) => {
  const sources = useQuery(getSources(workspaceId, chatId))
  return (
    <LabelList
      empty={<EmptyState Icon={BookOpen} title="No sources" hint="Documents the agent cites show here." />}
      rows={sources.map((source) => ({ key: source.name, label: source.name, value: source.origin }))}
    />
  )
}

export default SourcesTab
