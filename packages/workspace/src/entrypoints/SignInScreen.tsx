import { buttonClass, fieldClass, ghostButtonClass, labelClass, unexpectedFailureMessage } from '@spyria/ui'
import { type SubmitEvent, useState } from 'react'
import type { AccountProvider, SsoPreset } from '../domain/sso.ts'
import { AuthScreen } from './AuthScreen.tsx'
import { continueLabelOf, emptyProvider, isInstanceAppIn, ProviderFields } from './SignInSection.tsx'

type SignInProvider = { id: string; kind: SsoPreset; isWorkspaceSso: boolean }
type SignInOutcome = {
  status: string
  email?: string
  message?: string
  providers?: readonly SignInProvider[]
}

const accountProviderLabels: Record<AccountProvider, string> = {
  google: 'Continue with Google',
  microsoft: 'Continue with Microsoft',
  oidc: 'Continue with single sign-on',
}
const workspaceProviderLabels: Record<SsoPreset, string> = {
  google: "Continue with your organization's Google Workspace",
  microsoft: "Continue with your organization's Microsoft Entra",
  oidc: "Continue with your organization's sign-in",
}

const refusalOf = (outcome: SignInOutcome) => {
  if (outcome.status === 'not_invited') return `No workspace has invited ${outcome.email}`
  if (outcome.status === 'failed') return 'Sign-in through your provider did not complete. Try again.'
  if (outcome.status === 'refused') return outcome.message
}

const creationRefusalOf = (outcome: SignInOutcome) =>
  outcome.status === 'failed'
    ? 'Sign-in through your provider did not complete: no workspace was created'
    : refusalOf(outcome)

export const outcomeOrFailureOf = async (attempt: () => Promise<SignInOutcome>): Promise<SignInOutcome> => {
  try {
    return await attempt()
  } catch (error) {
    console.error(error)
    return { status: 'refused', message: unexpectedFailureMessage }
  }
}

const labelOf = (provider: SignInProvider) =>
  provider.isWorkspaceSso ? workspaceProviderLabels[provider.kind] : accountProviderLabels[provider.kind]

const FirstWorkspaceForm = ({
  setupToken,
  accountProviders,
  instanceApps,
  createFirstWorkspace,
}: {
  setupToken?: string
  accountProviders: readonly AccountProvider[]
  instanceApps: readonly SsoPreset[]
  createFirstWorkspace: (form: HTMLFormElement) => Promise<SignInOutcome>
}) => {
  const [isCreating, setIsCreating] = useState(false)
  const [usesOwnProvider, setUsesOwnProvider] = useState(accountProviders.length === 0)
  const [provider, setProvider] = useState(emptyProvider)
  const [clientSecret, setClientSecret] = useState('')
  const [usesInstanceApp, setUsesInstanceApp] = useState(true)
  const [refusal, setRefusal] = useState<string>()
  const create = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const chosen = form.elements.namedItem('accountProvider')
    if (chosen instanceof HTMLInputElement)
      chosen.value = (event.nativeEvent as globalThis.SubmitEvent).submitter?.getAttribute('value') ?? ''
    setIsCreating(true)
    const outcome = await outcomeOrFailureOf(() => createFirstWorkspace(form))
    setIsCreating(false)
    setRefusal(creationRefusalOf(outcome))
  }
  return (
    <AuthScreen title="Create a workspace" description="No workspace exists on this Spyria yet. You become its Admin.">
      <form aria-label="Create a workspace" onSubmit={create} className="flex flex-col gap-3">
        <input type="hidden" name="setupToken" value={setupToken ?? ''} />
        <label className={labelClass}>
          Workspace name
          <input name="name" required className={fieldClass} />
        </label>
        {usesOwnProvider ? (
          <>
            <p className="text-sm text-muted">
              Your organization's provider becomes the only way into this workspace. People you invite sign in through
              it at exactly the address you invite.
            </p>
            <ProviderFields
              provider={provider}
              edit={(field) => (event) => setProvider({ ...provider, [field]: event.target.value })}
              clientSecret={clientSecret}
              onClientSecretChange={setClientSecret}
              instanceApps={instanceApps}
              usesInstanceApp={usesInstanceApp}
              onUsesInstanceAppChange={setUsesInstanceApp}
            />
            <button type="submit" className={`${buttonClass} mt-2`} disabled={isCreating}>
              {isInstanceAppIn(instanceApps, provider.preset, usesInstanceApp)
                ? continueLabelOf(provider.preset)
                : 'Create and sign in'}
            </button>
            {accountProviders.length > 0 && (
              <button type="button" className={ghostButtonClass} onClick={() => setUsesOwnProvider(false)}>
                Sign in with your own account instead
              </button>
            )}
          </>
        ) : (
          <>
            <input type="hidden" name="accountProvider" />
            {accountProviders.map((kind) => (
              <button key={kind} type="submit" value={kind} className={buttonClass} disabled={isCreating}>
                {accountProviderLabels[kind]}
              </button>
            ))}
            <button type="button" className={ghostButtonClass} onClick={() => setUsesOwnProvider(true)}>
              Use your organization's provider instead
            </button>
          </>
        )}
      </form>
      {refusal && <p className="text-sm text-muted">{refusal}</p>}
    </AuthScreen>
  )
}

const AccountWorkspaceForm = ({ createWorkspace }: { createWorkspace: (name: string) => Promise<SignInOutcome> }) => {
  const [name, setName] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [refusal, setRefusal] = useState<string>()
  const create = async (event: SubmitEvent) => {
    event.preventDefault()
    setIsCreating(true)
    const outcome = await outcomeOrFailureOf(() => createWorkspace(name))
    setIsCreating(false)
    setRefusal(refusalOf(outcome))
  }
  return (
    <AuthScreen
      title="Create a workspace"
      description="You are signed in, but no workspace of yours opens with this account. Create one, or ask an Admin to invite this address."
    >
      <form aria-label="Create a workspace" onSubmit={create} className="flex flex-col gap-3">
        <label className={labelClass}>
          Workspace name
          <input required className={fieldClass} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <button type="submit" className={`${buttonClass} mt-2`} disabled={isCreating}>
          Create workspace
        </button>
      </form>
      {refusal && <p className="text-sm text-muted">{refusal}</p>}
    </AuthScreen>
  )
}

export const SignInScreen = ({
  isEmailFirst,
  isBeingSetUp = false,
  canCreateWorkspace,
  setupToken,
  accountProviders = [],
  instanceApps = [],
  notice,
  signInWithEmail,
  signIn,
  createFirstWorkspace,
  createWorkspace,
}: {
  isEmailFirst: boolean
  isBeingSetUp?: boolean
  canCreateWorkspace: boolean
  setupToken?: string
  accountProviders?: readonly AccountProvider[]
  instanceApps?: readonly SsoPreset[]
  notice?: string
  signInWithEmail: (email: string) => Promise<SignInOutcome>
  signIn: (target: { email?: string; provider?: string }) => Promise<SignInOutcome>
  createFirstWorkspace: (form: HTMLFormElement) => Promise<SignInOutcome>
  createWorkspace: (name: string) => Promise<SignInOutcome>
}) => {
  const [isSigningIn, setIsSigningIn] = useState(false)
  const [email, setEmail] = useState('')
  const [providers, setProviders] = useState<readonly SignInProvider[]>()
  const [hasNoWorkspace, setHasNoWorkspace] = useState(false)
  const [refusal, setRefusal] = useState(notice)
  const settle = (outcome: SignInOutcome) => {
    setIsSigningIn(false)
    setRefusal(refusalOf(outcome))
    if (outcome.status === 'choose_provider') setProviders(outcome.providers)
    if (outcome.status === 'no_workspace') setHasNoWorkspace(true)
  }
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    setIsSigningIn(true)
    settle(await outcomeOrFailureOf(() => (isEmailFirst ? signInWithEmail(email) : signIn({}))))
  }
  const useAnotherAddress = () => {
    setProviders(undefined)
    setRefusal(undefined)
  }
  const signInThrough = async (provider: SignInProvider) => {
    setIsSigningIn(true)
    settle(await outcomeOrFailureOf(() => signIn({ email, provider: provider.id })))
  }
  if (isBeingSetUp && !canCreateWorkspace)
    return (
      <AuthScreen
        title="This Spyria is being set up"
        description="No workspace exists yet. The person installing it has a setup link that creates the first one."
      />
    )
  if (canCreateWorkspace)
    return (
      <FirstWorkspaceForm
        setupToken={setupToken}
        accountProviders={accountProviders}
        instanceApps={instanceApps}
        createFirstWorkspace={createFirstWorkspace}
      />
    )
  if (hasNoWorkspace) return <AccountWorkspaceForm createWorkspace={createWorkspace} />
  return (
    <AuthScreen title="Sign in to Spyria">
      {providers ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">{email}</p>
          {providers.map((provider) => (
            <button
              key={provider.id}
              type="button"
              className={buttonClass}
              disabled={isSigningIn}
              onClick={() => signInThrough(provider)}
            >
              {labelOf(provider)}
            </button>
          ))}
          <button type="button" className={ghostButtonClass} onClick={useAnotherAddress}>
            Use another address
          </button>
        </div>
      ) : (
        <form aria-label="Sign in" onSubmit={submit} className="flex flex-col gap-3">
          {isEmailFirst && (
            <label className={labelClass}>
              Email
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
      )}
      {refusal && <p className="text-sm text-muted">{refusal}</p>}
    </AuthScreen>
  )
}
