import type { WorkspaceId } from '@spyria/kernel'
import {
  buttonClass,
  ErrorMessage,
  fieldClass,
  ghostButtonClass,
  LabelledSection,
  labelClass,
  useGuardedAction,
} from '@spyria/ui'
import { Check } from 'lucide-react'
import { type SubmitEvent, useEffect, useState } from 'react'
import { Link } from 'react-router'
import type { GitHubMemberAccount, GitHubSecrets, GitHubSettingsView } from '../domain/github.ts'
import { GitHubAppCreationForm } from './GitHubAppCreationForm.tsx'
import { GitHubAppGuide } from './GitHubAppGuide.tsx'
import { useWorkspaceCommands } from './providers.tsx'
import { useWorkspacePermissions } from './useWorkspacePermissions.ts'

const secretLabels = {
  clientSecret: 'Client secret',
  webhookSecret: 'Webhook secret',
}
const noSecrets: GitHubSecrets = { clientSecret: '', privateKey: '', webhookSecret: '' }

const accountStatusOf = ({ login, needsReconnection }: GitHubMemberAccount) => {
  if (!login) return 'Not connected'
  return needsReconnection ? `${login}, needs reconnection` : login
}

const MemberAccounts = ({ accounts }: { accounts: readonly GitHubMemberAccount[] }) => (
  <>
    <h3 className="text-sm font-medium">Members' accounts</h3>
    <p className="text-sm text-muted">
      Each member connects their own GitHub account in their profile: the agent pushes and opens pull requests with the
      account of the member who prompted.
    </p>
    <ul aria-label="Members' accounts" className="flex flex-col gap-1 text-sm">
      {accounts.map((account) => (
        <li key={account.memberId} className="flex gap-3">
          <span className="font-medium">{account.name}</span>
          <span className="text-muted">{accountStatusOf(account)}</span>
        </li>
      ))}
    </ul>
  </>
)

export const useIsGitHubConfigured = (workspaceId: WorkspaceId, isShown: boolean) => {
  const commands = useWorkspaceCommands()
  const canManageGitHub = useWorkspacePermissions(workspaceId).includes('github.manage')
  const [isConfigured, setIsConfigured] = useState(false)
  useEffect(() => {
    if (canManageGitHub && isShown)
      commands.isGitHubConfigured({ workspaceId }).then(setIsConfigured, () => setIsConfigured(false))
  }, [commands, workspaceId, canManageGitHub, isShown])
  return isConfigured
}

export const GitHubSection = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useWorkspaceCommands()
  const mayManageTools = useWorkspacePermissions(workspaceId).includes('tools.manage')
  const [settings, setSettings] = useState<GitHubSettingsView | null>()
  const [ids, setIds] = useState({ appId: '', clientId: '' })
  const [secrets, setSecrets] = useState(noSecrets)
  const [isSaved, setIsSaved] = useState(false)
  const [isManual, setIsManual] = useState(false)
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
      <p className="text-sm text-muted">
        Who may use GitHub's tools, and which of them, is set with the other tools in{' '}
        {mayManageTools ? (
          <Link to={`/w/${workspaceId}/settings/tools`} className="text-ink underline">
            Tools
          </Link>
        ) : (
          'Tools'
        )}
        .
      </p>
      {settings && (
        <>
          <p role="status" title="GitHub App connected" className="text-sm font-medium flex items-center gap-2">
            <Check className="size-4 text-green-500" aria-hidden />
            <span className="sr-only">GitHub App connected</span>
          </p>
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
          <MemberAccounts accounts={settings.memberAccounts} />
        </>
      )}
      {!settings && <GitHubAppCreationForm workspaceId={workspaceId} />}
      <button
        type="button"
        aria-expanded={isManual}
        className={`self-start ${ghostButtonClass}`}
        onClick={() => setIsManual(!isManual)}
      >
        {settings ? 'Change the App credentials' : 'Create it manually'}
      </button>
      {isManual && (
        <>
          <GitHubAppGuide />
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
        </>
      )}
    </LabelledSection>
  )
}
