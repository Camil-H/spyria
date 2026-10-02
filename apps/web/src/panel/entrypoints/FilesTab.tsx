import { type FileRow, useQuery } from '@hq/db'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { getFiles } from '../queries/get-files.ts'
import type { TabProps } from './TabProps.ts'
import { emptyClass, focusRing } from './ui.ts'

type TreeNode = { name: string; isFolder: boolean; children: TreeNode[] }

const buildTree = (files: readonly FileRow[]) => {
  const root: TreeNode = { name: '', isFolder: true, children: [] }
  for (const file of files) {
    const segments = file.path.split('/')
    let node = root
    segments.forEach((segment, index) => {
      let child = node.children.find((candidate) => candidate.name === segment)
      if (!child) {
        child = { name: segment, isFolder: index < segments.length - 1 || file.kind === 'folder', children: [] }
        node.children.push(child)
      }
      node = child
    })
  }
  return root.children
}

const TreeItems = ({ nodes }: { nodes: TreeNode[] }) => (
  <ul className="flex flex-col gap-1 text-sm">
    {nodes.map((node) => (
      <TreeItem key={node.name} node={node} />
    ))}
  </ul>
)

const TreeItem = ({ node }: { node: TreeNode }) => {
  const [isExpanded, setIsExpanded] = useState(false)
  if (!node.isFolder) return <li className="px-1 py-0.5">{node.name}</li>
  const Chevron = isExpanded ? ChevronDown : ChevronRight
  return (
    <li>
      <button
        type="button"
        aria-expanded={isExpanded}
        onClick={() => setIsExpanded(!isExpanded)}
        className={`flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-hover ${focusRing}`}
      >
        <Chevron aria-hidden size={14} />
        {node.name}
      </button>
      {isExpanded && (
        <div className="ml-4">
          <TreeItems nodes={node.children} />
        </div>
      )}
    </li>
  )
}

export const FilesTab = ({ workspaceId, chatId }: TabProps) => {
  const files = useQuery(getFiles(workspaceId, chatId))
  if (files.length === 0) return <p className={emptyClass}>No files</p>
  return <TreeItems nodes={buildTree(files)} />
}
