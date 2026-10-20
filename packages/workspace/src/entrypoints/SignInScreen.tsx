import { buttonClass, fieldClass, labelClass } from '@spyria/ui'
import { type SubmitEvent, useState } from 'react'
import { emptyProvider, ProviderFields } from './SignInSection.tsx'
import { fullScreenClass } from './ui.ts'

type SignInOutcome = { status: string; email?: string; domain?: string; message?: string }

const refusalOf = (outcome: SignInOutcome) => {
  if (outcome.status === 'not_invited') return `No workspace has invited ${outcome.email}`
  if (outcome.status === 'unknown_domain') return `No workspace signs in with ${outcome.domain}`
  if (outcome.status === 'refused') return outcome.message
}

const creationRefusalOf = (outcome: SignInOutcome) =>
  outcome.status === 'failed'
    ? 'Sign-in through your provider did not complete: no workspace was created'
    : refusalOf(outcome)

export const SignInScreen = ({
  isEmailFirst,
  canCreateWorkspace,
  signIn,
  createWorkspace,
}: {
  isEmailFirst: boolean
  canCreateWorkspace: boolean
  signIn: (email?: string) => Promise<SignInOutcome>
  createWorkspace: (form: HTMLFormElement) => Promise<SignInOutcome>
}) => {
  const [isSigningIn, setIsSigningIn] = useState(false)
  const [email, setEmail] = useState('')
  const [provider, setProvider] = useState(emptyProvider)
  const [clientSecret, setClientSecret] = useState('')
  const [refusal, setRefusal] = useState<string>()
  const settle = (outcome: SignInOutcome, refusalFor = refusalOf) => {
    setIsSigningIn(false)
    setRefusal(refusalFor(outcome))
  }
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    setIsSigningIn(true)
    settle(await signIn(isEmailFirst ? email : undefined))
  }
  const create = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    setIsSigningIn(true)
    settle(await createWorkspace(event.currentTarget), creationRefusalOf)
  }
  return canCreateWorkspace ? (
    <main className={fullScreenClass}>
      <h1 className="text-xl font-medium">Create a workspace</h1>
      <p className="max-w-sm text-sm text-muted">
        No workspace exists on this Spyria yet. The first person who signs in through your provider with an address at
        the email domain becomes the Admin of the new workspace.
      </p>
      <form aria-label="Create a workspace" onSubmit={create} className="flex w-full max-w-xs flex-col gap-3 text-left">
        <label className={labelClass}>
          Organization name
          <input name="name" required className={fieldClass} />
        </label>
        <label className={labelClass}>
          Email domain
          <input name="domain" required placeholder="acme.com" className={fieldClass} />
        </label>
        <ProviderFields
          provider={provider}
          edit={(field) => (event) => setProvider({ ...provider, [field]: event.target.value })}
          clientSecret={clientSecret}
          onClientSecretChange={setClientSecret}
        />
        <button type="submit" className={buttonClass} disabled={isSigningIn}>
          Create and sign in
        </button>
      </form>
      {refusal && <p className="max-w-sm text-sm text-muted">{refusal}</p>}
    </main>
  ) : (
    <main className={fullScreenClass}>
      <h1 className="text-xl font-medium">Sign in to Spyria</h1>
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
