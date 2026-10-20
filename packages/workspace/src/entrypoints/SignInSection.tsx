import type { WorkspaceId } from '@spyria/kernel'
import { buttonClass, ErrorMessage, fieldClass, LabelledSection, labelClass, useGuardedAction } from '@spyria/ui'
import { type SubmitEvent, useEffect, useState } from 'react'
import type { SsoDomainState, SsoPreset, SsoSettingsView } from '../domain/sso.ts'
import { useWorkspaceCommands } from './providers.tsx'

const presetLabels: Record<SsoPreset, string> = {
  google: 'Google Workspace',
  microsoft: 'Microsoft Entra',
  oidc: 'Other OIDC',
}
export const emptyProvider = { preset: 'google' as SsoPreset, issuer: '', tenantId: '', clientId: '' }
type ProviderField = keyof typeof emptyProvider

export const ProviderFields = ({
  provider,
  edit,
  clientSecret,
  onClientSecretChange,
  hasSecret = false,
}: {
  provider: typeof emptyProvider
  edit: (field: ProviderField) => (event: { target: { value: string } }) => void
  clientSecret: string
  onClientSecretChange: (clientSecret: string) => void
  hasSecret?: boolean
}) => (
  <>
    <label className={labelClass}>
      Provider
      <select name="preset" className={fieldClass} value={provider.preset} onChange={edit('preset')}>
        {Object.entries(presetLabels).map(([preset, presetLabel]) => (
          <option key={preset} value={preset}>
            {presetLabel}
          </option>
        ))}
      </select>
    </label>
    {provider.preset === 'microsoft' && (
      <label className={labelClass}>
        Tenant id
        <input name="tenantId" className={fieldClass} value={provider.tenantId} onChange={edit('tenantId')} />
      </label>
    )}
    {provider.preset === 'oidc' && (
      <label className={labelClass}>
        Issuer
        <input name="issuer" className={fieldClass} value={provider.issuer} onChange={edit('issuer')} />
      </label>
    )}
    <label className={labelClass}>
      Client id
      <input name="clientId" className={fieldClass} value={provider.clientId} onChange={edit('clientId')} />
    </label>
    <label className={labelClass}>
      Client secret
      <input
        name="clientSecret"
        type="password"
        autoComplete="off"
        className={fieldClass}
        placeholder={hasSecret ? 'Enter a new secret to replace it' : ''}
        value={clientSecret}
        onChange={(event) => onClientSecretChange(event.target.value)}
      />
    </label>
  </>
)

const statusOf = ({ isVerified, sentTo, expiresAt }: SsoDomainState) => {
  if (isVerified) return 'Verified'
  if (sentTo) return `Pending: sent to ${sentTo}, expires ${new Date(expiresAt ?? 0).toLocaleString()}`
  return 'Not verified'
}

const EmailDomain = ({
  workspaceId,
  state,
  onSent,
}: {
  workspaceId: WorkspaceId
  state: SsoDomainState
  onSent: (settings: SsoSettingsView | null) => void
}) => {
  const commands = useWorkspaceCommands()
  const [email, setEmail] = useState('')
  const { errorMessage, isPending, run } = useGuardedAction()
  const send = async (event: SubmitEvent) => {
    event.preventDefault()
    await run(async () => onSent(await commands.sendDomainVerification({ workspaceId, domain: state.domain, email })))
  }
  return (
    <section aria-label="Email domain" className="flex flex-col gap-1 text-sm">
      <div className="flex flex-wrap items-center gap-x-3">
        <span className="font-medium">{state.domain}</span>
        <span className="text-muted">{statusOf(state)}</span>
      </div>
      {!state.isVerified && (
        <form onSubmit={send} className="flex flex-wrap items-end gap-2">
          <input
            type="email"
            aria-label={`Address at ${state.domain}`}
            placeholder={`it@${state.domain}`}
            className={`${fieldClass} min-w-56 flex-1`}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <button type="submit" className={buttonClass} disabled={isPending || email.trim() === ''}>
            {state.sentTo ? 'Resend' : 'Send link'}
          </button>
          <div className="basis-full">
            <ErrorMessage message={errorMessage} />
          </div>
        </form>
      )}
    </section>
  )
}

export const SignInSection = ({ workspaceId, isDexSignIn }: { workspaceId: WorkspaceId; isDexSignIn: boolean }) =>
  isDexSignIn ? (
    <LabelledSection title="Sign-in">
      <p className="text-sm text-muted">Sign-in uses this deployment's Dex: SSO settings apply in SSO mode only.</p>
    </LabelledSection>
  ) : (
    <SsoSettingsForm workspaceId={workspaceId} />
  )

const SsoSettingsForm = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useWorkspaceCommands()
  const [form, setForm] = useState<SsoSettingsView | null>()
  const [clientSecret, setClientSecret] = useState('')
  const [isSaved, setIsSaved] = useState(false)
  const { errorMessage, isPending, run } = useGuardedAction()
  useEffect(() => {
    commands.readSsoSettings({ workspaceId }).then(setForm)
  }, [commands, workspaceId])
  if (!form)
    return (
      <LabelledSection title="Sign-in">
        <p className="text-sm text-muted">{form === null ? 'This workspace has no SSO settings.' : 'Loading…'}</p>
      </LabelledSection>
    )
  const edit = (field: ProviderField) => (event: { target: { value: string } }) => {
    setForm({ ...form, [field]: event.target.value })
    setIsSaved(false)
  }
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const saved = await run(async () => setForm(await commands.saveSsoSettings({ workspaceId, ...form, clientSecret })))
    if (saved) setClientSecret('')
    setIsSaved(saved)
  }
  return (
    <LabelledSection title="Sign-in">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <ProviderFields
          provider={form}
          edit={edit}
          clientSecret={clientSecret}
          onClientSecretChange={setClientSecret}
          hasSecret={form.hasSecret}
        />
        <p className="text-sm text-muted">{form.hasSecret ? 'Secret: set' : 'Secret: not set'}</p>
        <ErrorMessage message={errorMessage} />
        <div className="flex items-center gap-3">
          <button type="submit" className={buttonClass} disabled={isPending}>
            Save
          </button>
          {isSaved && <span className="text-sm text-muted">Saved</span>}
        </div>
      </form>
      <p className="text-sm text-muted">
        The email domain is set when the workspace is created. It routes sign-in once verified: send a link to any
        address at that domain.
      </p>
      <EmailDomain workspaceId={workspaceId} state={form.domainState} onSent={setForm} />
    </LabelledSection>
  )
}
