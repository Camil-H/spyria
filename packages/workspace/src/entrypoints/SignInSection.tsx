import type { WorkspaceId } from '@spyria/kernel'
import {
  buttonClass,
  CopyButton,
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
import type { SsoPreset, SsoSettingsView, SsoSuggestion } from '../domain/sso.ts'
import { DomainClaimsSection } from './DomainClaimsSection.tsx'
import { useWorkspaceCommands } from './providers.tsx'

const presetLabels: Record<SsoPreset, string> = {
  google: 'Google Workspace',
  microsoft: 'Microsoft Entra',
  oidc: 'Other OIDC',
}
const instanceAppNames: Record<SsoPreset, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
  oidc: 'single sign-on',
}
const ownAppGuides: Record<SsoPreset, string> = {
  google: 'Create an OAuth client of type Web application in Google Cloud › Credentials, with this redirect URI.',
  microsoft:
    'Create an app registration for accounts in this organizational directory only, with a client secret and this redirect URI.',
  oidc: 'Create a web client (authorization code) that sends email_verified, with this redirect URI.',
}
export const emptyProvider = { preset: 'google' as SsoPreset, issuer: '', tenantId: '', clientId: '' }
type ProviderField = keyof typeof emptyProvider
const switchLinkClass = `self-start text-sm text-link underline ${focusRing}`

export const isInstanceAppIn = (instanceApps: readonly SsoPreset[], preset: SsoPreset, usesInstanceApp: boolean) =>
  usesInstanceApp && instanceApps.includes(preset)
export const continueLabelOf = (preset: SsoPreset) => `Continue with ${instanceAppNames[preset]}`

const RedirectUri = ({ preset }: { preset: SsoPreset }) => {
  const redirectUri = `${location.origin}/auth/callback`
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-sm">
        <span>Redirect URI:</span>
        <code className="flex-1 font-mono text-xs break-all">{redirectUri}</code>
        <CopyButton text={redirectUri} label="Copy the redirect URI" className={ghostButtonClass} />
      </div>
      <p className="text-xs text-muted">{ownAppGuides[preset]}</p>
    </div>
  )
}

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
      {provider.preset === 'oidc' && !isInstanceApp && (
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
          <RedirectUri preset={provider.preset} />
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

const suggestionLabelOf = (suggestion: SsoSuggestion) => {
  if (suggestion.preset === 'microsoft') return `Microsoft Entra (tenant ${suggestion.tenantId})`
  if (suggestion.preset === 'oidc') return new URL(suggestion.issuer).host
  return presetLabels.google
}

const issuerKeyOf = (
  { preset, tenantId, issuer }: { preset: SsoPreset; tenantId: string; issuer: string },
  usesInstanceApp: boolean,
) => {
  if (preset === 'microsoft') return `microsoft ${tenantId.trim()}`
  if (preset === 'oidc') return usesInstanceApp ? 'oidc of this Spyria' : issuer.trim().replace(/\/$/, '')
  return preset
}

type AddressesAtOtherDomains = { addresses: string[]; count: number }

const AddressesAtOtherDomainsDialog = ({
  addresses,
  count,
  onEnforce,
  onClose,
}: AddressesAtOtherDomains & { onEnforce: () => void; onClose: () => void }) => (
  <Dialog label="Addresses at other domains" isWide onClose={onClose}>
    <p className="text-sm text-muted">
      These addresses are at another domain than yours. Once the provider is enforced, they sign in only if it has an
      account with that exact address:
    </p>
    <ul aria-label="Addresses at other domains" className="flex flex-col gap-1 text-sm">
      {addresses.map((address) => (
        <li key={address}>{address}</li>
      ))}
    </ul>
    {count > addresses.length && <p className="text-sm text-muted">and {count - addresses.length} more</p>}
    <button type="button" className={buttonClass} onClick={onEnforce}>
      Enforce anyway
    </button>
  </Dialog>
)

const confirmationNotice =
  'You confirm by signing in through the provider with your own address. A new provider signs everyone out of this workspace: members sign in again through it, matched by the address they were invited at.'

const SsoSettingsForm = ({
  workspaceId,
  instanceApps,
}: {
  workspaceId: WorkspaceId
  instanceApps: readonly SsoPreset[]
}) => {
  const commands = useWorkspaceCommands()
  const [stored, setStored] = useState<SsoSettingsView | null>()
  const [suggestion, setSuggestion] = useState<SsoSuggestion>()
  const [usesAnotherProvider, setUsesAnotherProvider] = useState(false)
  const [atOtherDomains, setAtOtherDomains] = useState<AddressesAtOtherDomains>({ addresses: [], count: 0 })
  const [formAwaitingWarning, setFormAwaitingWarning] = useState<HTMLFormElement>()
  const [form, setForm] = useState(emptyProvider)
  const [usesInstanceApp, setUsesInstanceApp] = useState(true)
  const [clientSecret, setClientSecret] = useState('')
  const [isConfirming, setIsConfirming] = useState(false)
  const [refusal, setRefusal] = useState<string>()
  const [isStopAsked, setIsStopAsked] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const { errorMessage, isPending, run } = useGuardedAction()
  useEffect(() => {
    Promise.all([
      commands.readSsoSettings({ workspaceId }),
      commands.readAddressesAtOtherDomains({ workspaceId }),
    ]).then(
      ([{ settings, suggestion }, addresses]) => {
        setStored(settings)
        setSuggestion(suggestion)
        setAtOtherDomains(addresses)
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
  const stop = () => run(() => commands.stopSso({ workspaceId }))
  const isOwnApp = !isInstanceAppIn(instanceApps, form.preset, usesInstanceApp)
  const confirm = async (providerForm: HTMLFormElement) => {
    setFormAwaitingWarning(undefined)
    setIsConfirming(true)
    const outcome = await commands.confirmSsoSettings({ workspaceId, form: providerForm })
    setIsConfirming(false)
    setRefusal(confirmationRefusalOf(outcome))
    if (outcome.status !== 'signed_in') return
    setClientSecret('')
    setStored((await commands.readSsoSettings({ workspaceId })).settings)
  }
  const submit = (event: SubmitEvent<HTMLFormElement>, changesIssuer: boolean) => {
    event.preventDefault()
    if (changesIssuer && atOtherDomains.count > 0) setFormAwaitingWarning(event.currentTarget)
    else confirm(event.currentTarget)
  }
  const changesIssuer = !stored || issuerKeyOf(stored, stored.usesInstanceApp) !== issuerKeyOf(form, !isOwnApp)
  const isSuggested = !stored && suggestion !== undefined && !usesAnotherProvider
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
        {isSuggested ? (
          <form
            aria-label="SSO provider"
            onSubmit={(event) => submit(event, true)}
            className={`${cardClass} flex flex-col gap-3 p-4`}
          >
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="preset" value={suggestion.preset} />
            <input type="hidden" name="usesInstanceApp" value="true" />
            {suggestion.tenantId && <input type="hidden" name="tenantId" value={suggestion.tenantId} />}
            <p className="text-sm">
              Enforce <strong className="font-medium">{suggestionLabelOf(suggestion)}</strong> for this workspace
            </p>
            <p className={calloutClass}>{confirmationNotice}</p>
            <button type="submit" className={`self-start ${buttonClass}`} disabled={isConfirming}>
              Enforce SSO
            </button>
            <button type="button" className={switchLinkClass} onClick={() => setUsesAnotherProvider(true)}>
              Use another provider
            </button>
            {refusal && <p className="text-sm text-muted">{refusal}</p>}
          </form>
        ) : (
          <form
            aria-label="SSO provider"
            onSubmit={(event) => submit(event, changesIssuer)}
            className={`${cardClass} flex flex-col gap-3 p-4`}
          >
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
            <p className={calloutClass}>{confirmationNotice}</p>
            <button type="submit" className={`self-start ${buttonClass}`} disabled={isConfirming}>
              {stored ? 'Save and sign in again' : 'Enforce SSO'}
            </button>
            {refusal && <p className="text-sm text-muted">{refusal}</p>}
          </form>
        )}
      </LabelledSection>
      {formAwaitingWarning && (
        <AddressesAtOtherDomainsDialog
          {...atOtherDomains}
          onEnforce={() => confirm(formAwaitingWarning)}
          onClose={() => setFormAwaitingWarning(undefined)}
        />
      )}
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
