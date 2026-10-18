import type { WorkspaceId } from '@hq/kernel'
import { buttonClass, ErrorMessage, fieldClass, LabelledSection, labelClass, useGuardedAction } from '@hq/ui'
import { type SubmitEvent, useEffect, useState } from 'react'
import type { GitHubSecrets, GitHubSettingsView } from '../domain/github.ts'
import { useWorkspaceCommands } from './providers.tsx'

const secretLabels = {
  clientSecret: 'Client secret',
  webhookSecret: 'Webhook secret',
}
const noSecrets: GitHubSecrets = { clientSecret: '', privateKey: '', webhookSecret: '' }

export const GitHubSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useWorkspaceCommands()
  const [settings, setSettings] = useState<GitHubSettingsView | null>()
  const [ids, setIds] = useState({ appId: '', clientId: '' })
  const [secrets, setSecrets] = useState(noSecrets)
  const [isSaved, setIsSaved] = useState(false)
  const { errorMessage, isPending, run } = useGuardedAction()
  const show = (shown: GitHubSettingsView | null) => {
    setSettings(shown)
    setIds({ appId: shown?.appId ?? '', clientId: shown?.clientId ?? '' })
  }
  useEffect(() => {
    const shown = (read: GitHubSettingsView | null) => {
      setSettings(read)
      setIds({ appId: read?.appId ?? '', clientId: read?.clientId ?? '' })
    }
    commands.readGitHubSettings({ workspaceId }).then(shown, () => shown(null))
  }, [commands, workspaceId])
  if (settings === undefined)
    return (
      <LabelledSection title="GitHub">
        <p className="text-sm text-muted">Loading…</p>
      </LabelledSection>
    )
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const saved = await run(async () => show(await commands.saveGitHubSettings({ workspaceId, ...ids, ...secrets })))
    if (saved) setSecrets(noSecrets)
    setIsSaved(saved)
  }
  const placeholder = settings ? 'Set: enter a new value to replace it' : 'Not set'
  return (
    <LabelledSection title="GitHub">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className={labelClass}>
          App id
          <input
            className={fieldClass}
            value={ids.appId}
            onChange={(event) => setIds({ ...ids, appId: event.target.value })}
          />
        </label>
        <label className={labelClass}>
          Client id
          <input
            className={fieldClass}
            value={ids.clientId}
            onChange={(event) => setIds({ ...ids, clientId: event.target.value })}
          />
        </label>
        <label className={labelClass}>
          Private key
          <textarea
            className={`${fieldClass} h-20 font-mono text-xs`}
            placeholder={placeholder}
            value={secrets.privateKey}
            onChange={(event) => setSecrets({ ...secrets, privateKey: event.target.value })}
          />
        </label>
        {(['clientSecret', 'webhookSecret'] as const).map((name) => (
          <label key={name} className={labelClass}>
            {secretLabels[name]}
            <input
              type="password"
              autoComplete="off"
              className={fieldClass}
              placeholder={placeholder}
              value={secrets[name]}
              onChange={(event) => setSecrets({ ...secrets, [name]: event.target.value })}
            />
          </label>
        ))}
        <ErrorMessage message={errorMessage} />
        <div className="flex items-center gap-3">
          <button type="submit" className={buttonClass} disabled={isPending}>
            Save
          </button>
          {isSaved && <span className="text-sm text-muted">Saved</span>}
        </div>
      </form>
      {settings && (
        <>
          <h3 className="text-sm font-medium">Granted repositories</h3>
          {settings.listingFailure ? (
            <ErrorMessage message={settings.listingFailure} />
          ) : settings.repositories.length === 0 ? (
            <p className="text-sm text-muted">The App is installed on no repository</p>
          ) : (
            <ul aria-label="Granted repositories" className="flex flex-col gap-1 text-sm">
              {settings.repositories.map(({ fullName, defaultBranch }) => (
                <li key={fullName} className="flex gap-3">
                  <span className="font-medium">{fullName}</span>
                  <span className="text-muted">{defaultBranch}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </LabelledSection>
  )
}
