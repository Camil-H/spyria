import { focusRing } from '@hq/ui'
import { Link } from 'react-router'

export const NoAccessScreen = () => (
  <main className="flex h-screen flex-col items-center justify-center gap-4 bg-app p-6 text-center text-ink">
    <p className="text-xl font-medium">You don't have access to this workspace</p>
    <Link to="/" className={`rounded-md px-2 py-1 text-sm underline ${focusRing}`}>
      Back to my workspaces
    </Link>
  </main>
)
