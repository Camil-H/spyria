import type { WorkspaceId } from '@spyria/kernel'
import {
  buttonClass,
  calloutClass,
  cardClass,
  Dialog,
  dangerButtonClass,
  ErrorMessage,
  failureMessageOf,
  fieldClass,
  focusRing,
  ghostButtonClass,
  LabelledSection,
  labelClass,
  rowListClass,
  SettingRow,
  StatusBadge,
  useGuardedAction,
} from '@spyria/ui'
import { type SubmitEvent, useEffect, useState } from 'react'
import type { SsoPreset, SsoSettingsView } from '../domain/sso.ts'
import { DomainClaimsSection } from './DomainClaimsSection.tsx'
import { useWorkspaceCommands } from './providers.tsx'

const presetLabels: Record<SsoPreset, string> = {
  google: 'Google Workspace',
  microsoft: 'Microsoft Entra',
  oidc: 'Other OIDC',
}
const instanceAppNames: Record<SsoPreset, string> = { google: 'Google', microsoft: 'Microsoft', oidc: '' }
export const emptyProvider = { preset: 'google' as SsoPreset, issuer: '', tenantId: '', clientId: '' }
type ProviderField = keyof typeof emptyProvider
const switchLinkClass = `self-start text-sm text-link underline ${focusRing}`

export const isInstanceAppIn = (instanceApps: readonly SsoPreset[], preset: SsoPreset, usesInstanceApp: boolean) =>
  usesInstanceApp && instanceApps.includes(preset)
export const continueLabelOf = (preset: SsoPreset) => `Continue with ${instanceAppNames[preset]}`

export const ProviderFields = ({
  provider,
  edit,
  clientSecret,
  onClientSecretChange,
  hasSecret = false,
  instanceApps = [],
  usesInstanceApp = false,
  onUsesInstanceAppChange,
}: {
  provider: typeof emptyProvider
  edit: (field: ProviderField) => (event: { target: { value: string } }) => void
  clientSecret: string
  onClientSecretChange: (clientSecret: string) => void
  hasSecret?: boolean
  instanceApps?: readonly SsoPreset[]
  usesInstanceApp?: boolean
  onUsesInstanceAppChange?: (usesInstanceApp: boolean) => void
}) => {
  const canUseInstanceApp = instanceApps.includes(provider.preset)
  const isInstanceApp = isInstanceAppIn(instanceApps, provider.preset, usesInstanceApp)
  return (
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
      {isInstanceApp ? (
        <>
          <input type="hidden" name="usesInstanceApp" value="true" />
          <p className="text-sm text-muted">
            Members sign in through the {instanceAppNames[provider.preset]} app of this Spyria: there is no client id or
            secret to enter.
          </p>
          <button type="button" className={switchLinkClass} onClick={() => onUsesInstanceAppChange?.(false)}>
            Use your own app
          </button>
        </>
      ) : (
        <>
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
          {canUseInstanceApp && (
            <button type="button" className={switchLinkClass} onClick={() => onUsesInstanceAppChange?.(true)}>
              Use the {instanceAppNames[provider.preset]} app of this Spyria
            </button>
          )}
        </>
      )}
    </>
  )
}

const confirmationRefusalOf = (outcome: { status: string; message?: string }) => {
  if (outcome.status === 'refused') return outcome.message
  if (outcome.status === 'failed' || outcome.status === 'not_invited')
    return 'Sign-in through the provider did not complete: nothing was changed'
}

export const SignInSection = ({
  workspaceId,
  isDexSignIn,
  instanceApps = [],
}: {
  workspaceId: WorkspaceId
  isDexSignIn: boolean
  instanceApps?: readonly SsoPreset[]
}) =>
  isDexSignIn ? (
    <section aria-label="Sign-in" className={`${rowListClass} max-w-2xl`}>
      <SettingRow title="Sign-in uses this deployment's Dex" description="SSO settings apply in SSO mode only.">
        <StatusBadge tone="ok">Dex</StatusBadge>
      </SettingRow>
    </section>
  ) : (
    <SsoSettingsForm workspaceId={workspaceId} instanceApps={instanceApps} />
  )

const SsoSettingsForm = ({
  workspaceId,
  instanceApps,
}: {
  workspaceId: WorkspaceId
  instanceApps: readonly SsoPreset[]
}) => {
  const commands = useWorkspaceCommands()
  const [stored, setStored] = useState<SsoSettingsView | null>()
  const [form, setForm] = useState(emptyProvider)
  const [usesInstanceApp, setUsesInstanceApp] = useState(true)
  const [clientSecret, setClientSecret] = useState('')
  const [isConfirming, setIsConfirming] = useState(false)
  const [refusal, setRefusal] = useState<string>()
  const [isStopAsked, setIsStopAsked] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const { errorMessage, isPending, run } = useGuardedAction()
  useEffect(() => {
    commands.readSsoSettings({ workspaceId }).then(
      (settings) => {
        setStored(settings)
        if (settings) {
          setForm({ ...emptyProvider, ...settings })
          setUsesInstanceApp(settings.usesInstanceApp)
        }
      },
      (error: unknown) => setLoadError(failureMessageOf(error)),
    )
  }, [commands, workspaceId])
  if (stored === undefined)
    return (
      <section aria-label="Sign-in">
        {loadError ? <ErrorMessage message={loadError} /> : <p className="text-sm text-muted">Loading…</p>}
      </section>
    )
  const edit = (field: ProviderField) => (event: { target: { value: string } }) =>
    setForm({ ...form, [field]: event.target.value })
  const confirm = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    setIsConfirming(true)
    const outcome = await commands.confirmSsoSettings({ workspaceId, form: event.currentTarget })
    setIsConfirming(false)
    setRefusal(confirmationRefusalOf(outcome))
    if (outcome.status !== 'signed_in') return
    setClientSecret('')
    setStored(await commands.readSsoSettings({ workspaceId }))
  }
  const stop = () => run(() => commands.stopSso({ workspaceId }))
  const isOwnApp = !isInstanceAppIn(instanceApps, form.preset, usesInstanceApp)
  return (
    <section aria-label="Sign-in" className="flex max-w-2xl flex-col gap-6">
      <div className={rowListClass}>
        <SettingRow
          title={stored ? 'SSO enforced' : 'SSO not enforced'}
          description={
            stored
              ? "This workspace enforces SSO: only your organization's provider opens it, for everyone, Admins included."
              : "Members sign in with their own account, through the sign-in of this Spyria. Enforce SSO to make your organization's provider the only way into this workspace."
          }
        >
          <StatusBadge tone={stored ? 'ok' : 'off'}>{stored ? presetLabels[stored.preset] : 'Off'}</StatusBadge>
        </SettingRow>
      </div>
      <LabelledSection title={stored ? 'Provider' : 'Enforce SSO'} titleClass="text-sm font-medium">
        <form aria-label="SSO provider" onSubmit={confirm} className={`${cardClass} flex flex-col gap-3 p-4`}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <ProviderFields
            provider={form}
            edit={edit}
            clientSecret={clientSecret}
            onClientSecretChange={setClientSecret}
            hasSecret={stored?.hasSecret}
            instanceApps={instanceApps}
            usesInstanceApp={usesInstanceApp}
            onUsesInstanceAppChange={setUsesInstanceApp}
          />
          {stored && isOwnApp && (
            <p className="-mt-1 text-xs text-muted">{stored.hasSecret ? 'Secret: set' : 'Secret: not set'}</p>
          )}
          <p className={calloutClass}>
            You confirm by signing in through the provider with your own address. A new provider signs everyone out of
            this workspace: members sign in again through it, matched by the address they were invited at.
          </p>
          <button type="submit" className={`self-start ${buttonClass}`} disabled={isConfirming}>
            {stored ? 'Save and sign in again' : 'Enforce SSO'}
          </button>
          {refusal && <p className="text-sm text-muted">{refusal}</p>}
        </form>
      </LabelledSection>
      {stored && <DomainClaimsSection workspaceId={workspaceId} />}
      {stored && (
        <div className={rowListClass}>
          <SettingRow title="Stop enforcing SSO" description="Members go back to signing in with their own account">
            <button type="button" className={ghostButtonClass} onClick={() => setIsStopAsked(true)}>
              Stop enforcing SSO
            </button>
          </SettingRow>
        </div>
      )}
      {isStopAsked && (
        <Dialog label="Stop enforcing SSO" onClose={() => setIsStopAsked(false)}>
          <p className="text-sm text-muted">
            Everyone is signed out of this workspace, you included, and signs in again with their own account. Its
            claimed domains are released.
          </p>
          <ErrorMessage message={errorMessage} />
          <button type="button" className={dangerButtonClass} disabled={isPending} onClick={stop}>
            Stop enforcing
          </button>
        </Dialog>
      )}
    </section>
  )
}
