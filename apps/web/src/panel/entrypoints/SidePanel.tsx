import { useQuery } from '@hq/db'
import { tooltipClass } from '@hq/ui'
import { Content, List, Root, Trigger } from '@radix-ui/react-tabs'
import {
  Content as TooltipContent,
  Portal as TooltipPortal,
  Provider as TooltipProvider,
  Root as TooltipRoot,
  Trigger as TooltipTrigger,
} from '@radix-ui/react-tooltip'
import {
  BookOpen,
  ChartColumn,
  FileDiff,
  FolderTree,
  GitCommitHorizontal,
  Globe,
  ListChecks,
  type LucideIcon,
  Plug,
  Terminal,
  Users,
} from 'lucide-react'
import { Activity, type ComponentType, useState } from 'react'
import { getPanelTabs, type PanelTabId } from '../queries/get-panel-tabs.ts'
import { BrowserTab } from './BrowserTab.tsx'
import { ChangesTab } from './ChangesTab.tsx'
import { CommitsTab } from './CommitsTab.tsx'
import { ConnectionsTab } from './ConnectionsTab.tsx'
import { FilesTab } from './FilesTab.tsx'
import { MembersTab } from './MembersTab.tsx'
import { PlanTab } from './PlanTab.tsx'
import { usePanel } from './providers.tsx'
import { ResizeHandle } from './ResizeHandle.tsx'
import { SourcesTab } from './SourcesTab.tsx'
import type { TabProps } from './TabProps.ts'
import { TerminalTab } from './TerminalTab.tsx'
import { UsageTab } from './UsageTab.tsx'
import { tabClass } from './ui.ts'

const tabs: Record<PanelTabId, { label: string; Icon: LucideIcon; Component: ComponentType<TabProps> }> = {
  files: { label: 'Files', Icon: FolderTree, Component: FilesTab },
  changes: { label: 'Changes', Icon: FileDiff, Component: ChangesTab },
  terminal: { label: 'Terminal', Icon: Terminal, Component: TerminalTab },
  plan: { label: 'Plan', Icon: ListChecks, Component: PlanTab },
  commits: { label: 'Commits', Icon: GitCommitHorizontal, Component: CommitsTab },
  browser: { label: 'Browser', Icon: Globe, Component: BrowserTab },
  sources: { label: 'Sources', Icon: BookOpen, Component: SourcesTab },
  usage: { label: 'Usage', Icon: ChartColumn, Component: UsageTab },
  connections: { label: 'Connected tools', Icon: Plug, Component: ConnectionsTab },
  members: { label: 'Members', Icon: Users, Component: MembersTab },
}

const TabTrigger = ({ tabId, label, Icon }: { tabId: PanelTabId; label: string; Icon: LucideIcon }) => {
  const [isTooltipOpen, setIsTooltipOpen] = useState(false)
  return (
    <TooltipRoot
      open={isTooltipOpen}
      onOpenChange={(isOpen) => setTimeout(() => setIsTooltipOpen(isOpen), 100)}
      disableHoverableContent
    >
      <Trigger
        asChild
        value={tabId}
        onFocus={(event) => event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' })}
      >
        <TooltipTrigger aria-label={label} className={tabClass}>
          <Icon aria-hidden className="size-4" />
        </TooltipTrigger>
      </Trigger>
      <TooltipPortal>
        <TooltipContent sideOffset={6} className={tooltipClass}>
          {label}
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  )
}

export const SidePanel = ({ workspaceId, chatId }: TabProps) => {
  const tabIds = useQuery(getPanelTabs(workspaceId, chatId))
  const { isOpen, width } = usePanel()
  if (!tabIds) return null
  return (
    <Activity mode={isOpen ? 'visible' : 'hidden'}>
      <section
        aria-label="Side panel"
        style={{ width }}
        className="relative flex min-w-0 shrink-0 flex-col border-l border-line bg-raised text-ink"
      >
        <ResizeHandle />
        <Root key={chatId} defaultValue={tabIds[0]} className="flex min-h-0 flex-1 flex-col">
          <TooltipProvider>
            <List aria-label="Panel tabs" className="flex overflow-x-auto border-b border-line px-1 scrollbar-thin">
              {tabIds.map((tabId) => {
                const { label, Icon } = tabs[tabId]
                return <TabTrigger key={tabId} tabId={tabId} label={label} Icon={Icon} />
              })}
            </List>
          </TooltipProvider>
          {tabIds.map((tabId) => {
            const { Component } = tabs[tabId]
            return (
              <Content key={tabId} value={tabId} className="min-h-0 flex-1 overflow-y-auto p-4 text-ink">
                <Component workspaceId={workspaceId} chatId={chatId} />
              </Content>
            )
          })}
        </Root>
      </section>
    </Activity>
  )
}
