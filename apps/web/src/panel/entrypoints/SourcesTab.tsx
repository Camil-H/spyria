import { useQuery } from '@hq/db'
import { getSources } from '../queries/get-sources.ts'
import { LabelList } from './LabelList.tsx'
import type { TabProps } from './TabProps.ts'

export const SourcesTab = ({ workspaceId, chatId }: TabProps) => {
  const sources = useQuery(getSources(workspaceId, chatId))
  return (
    <LabelList
      emptyMessage="No sources"
      rows={sources.map((source) => ({ key: source.name, label: source.name, value: source.origin }))}
    />
  )
}
