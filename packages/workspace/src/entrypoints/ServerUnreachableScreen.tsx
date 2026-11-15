import { buttonClass } from '@spyria/ui'
import { AuthScreen } from './AuthScreen.tsx'

export const ServerUnreachableScreen = () => (
  <AuthScreen title="Spyria could not be reached" description="Check your connection, then try again.">
    <button type="button" className={buttonClass} onClick={() => location.reload()}>
      Try again
    </button>
  </AuthScreen>
)
