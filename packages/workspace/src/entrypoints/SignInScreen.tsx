import { buttonClass, fieldClass, labelClass } from '@spyria/ui'
import { type SubmitEvent, useState } from 'react'
import type { SsoPreset } from '../domain/sso.ts'
import { AuthScreen } from './AuthScreen.tsx'
import { continueLabelOf, emptyProvider, isInstanceAppIn, ProviderFields } from './SignInSection.tsx'

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
  instanceApps = [],
  notice,
  signIn,
  createWorkspace,
}: {
  isEmailFirst: boolean
  canCreateWorkspace: boolean
  instanceApps?: readonly SsoPreset[]
  notice?: string
  signIn: (email?: string) => Promise<SignInOutcome>
  createWorkspace: (form: HTMLFormElement) => Promise<SignInOutcome>
}) => {
  const [isSigningIn, setIsSigningIn] = useState(false)
  const [email, setEmail] = useState('')
  const [provider, setProvider] = useState(emptyProvider)
  const [clientSecret, setClientSecret] = useState('')
  const [usesInstanceApp, setUsesInstanceApp] = useState(true)
  const [refusal, setRefusal] = useState(notice)
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
    <AuthScreen title="Create a workspace" description="No workspace exists on this Spyria yet.">
      <form aria-label="Create a workspace" onSubmit={create} className="flex flex-col gap-3">
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
          instanceApps={instanceApps}
          usesInstanceApp={usesInstanceApp}
          onUsesInstanceAppChange={setUsesInstanceApp}
        />
        <button type="submit" className={`${buttonClass} mt-2`} disabled={isSigningIn}>
          {isInstanceAppIn(instanceApps, provider.preset, usesInstanceApp)
            ? continueLabelOf(provider.preset)
            : 'Create and sign in'}
        </button>
      </form>
      {refusal && <p className="text-sm text-muted">{refusal}</p>}
    </AuthScreen>
  ) : (
    <AuthScreen title="Sign in to Spyria">
      <form aria-label="Sign in" onSubmit={submit} className="flex flex-col gap-3">
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
        <button type="submit" className={`${buttonClass} mt-2`} disabled={isSigningIn}>
          {isEmailFirst ? 'Continue' : 'Sign in'}
        </button>
      </form>
      {refusal && <p className="text-sm text-muted">{refusal}</p>}
    </AuthScreen>
  )
}
