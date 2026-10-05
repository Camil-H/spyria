import { buttonClass } from '@hq/ui'
import { useState } from 'react'
import { fullScreenClass } from './ui.ts'

type SignInOutcome = { status: string; email?: string }

export const SignInScreen = ({ signIn }: { signIn: () => Promise<SignInOutcome> }) => {
  const [isSigningIn, setIsSigningIn] = useState(false)
  const [uninvitedEmail, setUninvitedEmail] = useState<string>()
  const startSignIn = async () => {
    setIsSigningIn(true)
    const outcome = await signIn()
    setIsSigningIn(false)
    setUninvitedEmail(outcome.status === 'not_invited' ? outcome.email : undefined)
  }
  return (
    <main className={fullScreenClass}>
      <h1 className="text-xl font-medium">Sign in to HQ</h1>
      <button type="button" className={buttonClass} disabled={isSigningIn} onClick={startSignIn}>
        Sign in
      </button>
      {uninvitedEmail && <p className="text-sm text-muted">No workspace has invited {uninvitedEmail}</p>}
    </main>
  )
}
