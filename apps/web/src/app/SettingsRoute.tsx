import type { WorkspaceId } from '@hq/kernel'
import { RuntimeHostsSection } from '@hq/runtime'
import { UsageSection } from '@hq/usage'
import { useIsWorkspaceAdmin } from '@hq/workspace'
import { useOutletContext } from 'react-router'

const SettingsRoute = () => {
  const workspaceId = useOutletContext<WorkspaceId>()
  const isAdmin = useIsWorkspaceAdmin(workspaceId)
  return (
    <div className="flex max-w-3xl flex-col gap-8 p-6">
      <h1 className="text-2xl font-semibold">Workspace settings</h1>
      {isAdmin ? (
        <>
          <RuntimeHostsSection workspaceId={workspaceId} />
          <UsageSection workspaceId={workspaceId} />
        </>
      ) : (
        <p className="text-muted">Only workspace admins can see this page</p>
      )}
    </div>
  )
}

export default SettingsRoute
