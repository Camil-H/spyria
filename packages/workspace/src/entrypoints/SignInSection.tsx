import type { WorkspaceId } from '@hq/kernel'
import { buttonClass, ErrorMessage, fieldClass, LabelledSection, labelClass, useGuardedAction } from '@hq/ui'
import { type SubmitEvent, useEffect, useState } from 'react'
import type { SsoPreset, SsoSettingsView } from '../domain/sso.ts'
import { useWorkspaceCommands } from './providers.tsx'

const presetLabels: Record<SsoPreset, string> = {
  google: 'Google Workspace',
  microsoft: 'Microsoft Entra',
  oidc: 'Other OIDC',
}
const emptyForm = {
  preset: 'google' as SsoPreset,
  issuer: '',
  tenantId: '',
  clientId: '',
  domains: '',
  hasSecret: false,
}

const formOf = (settings: SsoSettingsView | null) =>
  settings ? { ...settings, domains: settings.domains.join(', ') } : emptyForm

export const SignInSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useWorkspaceCommands()
  const [form, setForm] = useState(emptyForm)
  const [clientSecret, setClientSecret] = useState('')
  const [isSaved, setIsSaved] = useState(false)
  const { errorMessage, isPending, run } = useGuardedAction()
  useEffect(() => {
    commands.readSsoSettings({ workspaceId }).then((settings) => setForm(formOf(settings)))
  }, [commands, workspaceId])
  const edit =
    (field: 'preset' | 'issuer' | 'tenantId' | 'clientId' | 'domains') => (event: { target: { value: string } }) => {
      setForm({ ...form, [field]: event.target.value })
      setIsSaved(false)
    }
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const domains = form.domains.split(',')
    const saved = await run(async () =>
      setForm(formOf(await commands.saveSsoSettings({ workspaceId, ...form, domains, clientSecret }))),
    )
    if (saved) setClientSecret('')
    setIsSaved(saved)
  }
  return (
    <LabelledSection title="Sign-in">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className={labelClass}>
          Provider
          <select className={fieldClass} value={form.preset} onChange={edit('preset')}>
            {Object.entries(presetLabels).map(([preset, presetLabel]) => (
              <option key={preset} value={preset}>
                {presetLabel}
              </option>
            ))}
          </select>
        </label>
        {form.preset === 'microsoft' && (
          <label className={labelClass}>
            Tenant id
            <input className={fieldClass} value={form.tenantId} onChange={edit('tenantId')} />
          </label>
        )}
        {form.preset === 'oidc' && (
          <label className={labelClass}>
            Issuer
            <input className={fieldClass} value={form.issuer} onChange={edit('issuer')} />
          </label>
        )}
        <label className={labelClass}>
          Client id
          <input className={fieldClass} value={form.clientId} onChange={edit('clientId')} />
        </label>
        <label className={labelClass}>
          Client secret
          <input
            type="password"
            autoComplete="off"
            className={fieldClass}
            placeholder={form.hasSecret ? 'Enter a new secret to replace it' : ''}
            value={clientSecret}
            onChange={(event) => setClientSecret(event.target.value)}
          />
        </label>
        <p className="text-sm text-muted">{form.hasSecret ? 'Secret: set' : 'Secret: not set'}</p>
        <label className={labelClass}>
          Email domains
          <input className={fieldClass} placeholder="acme.com" value={form.domains} onChange={edit('domains')} />
        </label>
        <ErrorMessage message={errorMessage} />
        <div className="flex items-center gap-3">
          <button type="submit" className={buttonClass} disabled={isPending}>
            Save
          </button>
          {isSaved && <span className="text-sm text-muted">Saved</span>}
        </div>
      </form>
    </LabelledSection>
  )
}
