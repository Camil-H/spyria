import { focusRing } from '@hq/ui'
import { Link } from 'react-router'
import { fullScreenClass } from './ui.ts'

export const NoAccessScreen = () => (
  <main className={fullScreenClass}>
    <p className="text-xl font-medium">You don't have access to this workspace</p>
    <Link to="/" className={`rounded-md px-2 py-1 text-sm underline ${focusRing}`}>
      Back to my workspaces
    </Link>
  </main>
)
