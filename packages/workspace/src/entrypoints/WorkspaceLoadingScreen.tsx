import { buttonClass } from '@spyria/ui'
import { AuthScreen } from './AuthScreen.tsx'

export const WorkspaceLoadingScreen = () => (
  <AuthScreen
    title="Opening your workspace"
    description="This is taking longer than usual. Spyria keeps trying and opens it as soon as it arrives."
  >
    <button type="button" className={buttonClass} onClick={() => location.reload()}>
      Try again
    </button>
  </AuthScreen>
)
