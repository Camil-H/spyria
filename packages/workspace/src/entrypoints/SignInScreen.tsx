import { buttonClass, fieldClass, labelClass } from '@hq/ui'
import { type SubmitEvent, useState } from 'react'
import { fullScreenClass } from './ui.ts'

type SignInOutcome = { status: string; email?: string; domain?: string }

const refusalOf = (outcome: SignInOutcome) => {
  if (outcome.status === 'not_invited') return `No workspace has invited ${outcome.email}`
  if (outcome.status === 'unknown_domain') return `No workspace signs in with ${outcome.domain}`
}

export const SignInScreen = ({
  isEmailFirst,
  signIn,
}: {
  isEmailFirst: boolean
  signIn: (email?: string) => Promise<SignInOutcome>
}) => {
  const [isSigningIn, setIsSigningIn] = useState(false)
  const [email, setEmail] = useState('')
  const [refusal, setRefusal] = useState<string>()
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    setIsSigningIn(true)
    const outcome = await signIn(isEmailFirst ? email : undefined)
    setIsSigningIn(false)
    setRefusal(refusalOf(outcome))
  }
  return (
    <main className={fullScreenClass}>
      <h1 className="text-xl font-medium">Sign in to HQ</h1>
      <form aria-label="Sign in" onSubmit={submit} className="flex w-full max-w-xs flex-col gap-3 text-left">
        {isEmailFirst && (
          <label className={labelClass}>
            Work email
            <input
              type="email"
              required
              autoComplete="email"
              className={fieldClass}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
        )}
        <button type="submit" className={buttonClass} disabled={isSigningIn}>
          {isEmailFirst ? 'Continue' : 'Sign in'}
        </button>
      </form>
      {refusal && <p className="text-sm text-muted">{refusal}</p>}
    </main>
  )
}
