import type { WorkspaceId } from '@spyria/kernel'
import {
  buttonClass,
  cardClass,
  ErrorMessage,
  fieldClass,
  ghostButtonClass,
  LabelledSection,
  labelClass,
  rowClass,
  rowListClass,
  SettingRow,
  StatusBadge,
  type StatusTone,
  useGuardedAction,
} from '@spyria/ui'
import { GitBranch } from 'lucide-react'
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

const accountToneOf = ({ login, needsReconnection }: GitHubMemberAccount): StatusTone => {
  if (!login) return 'off'
  return needsReconnection ? 'attention' : 'ok'
}

const MemberAccounts = ({ accounts }: { accounts: readonly GitHubMemberAccount[] }) => (
  <LabelledSection title="Members' accounts" titleClass="text-sm font-medium">
    <p className="-mt-2 text-sm text-muted">
      The agent pushes and opens pull requests with the account of the member who prompted. Each member connects theirs
      in their profile.
    </p>
    <ul aria-label="Members' accounts" className={rowListClass}>
      {accounts.map((account) => (
        <li key={account.memberId} className={rowClass}>
          <span className="w-48 truncate font-medium">{account.name}</span>
          <StatusBadge tone={accountToneOf(account)}>{accountStatusOf(account)}</StatusBadge>
        </li>
      ))}
    </ul>
  </LabelledSection>
)

const GrantedRepositories = ({ settings }: { settings: GitHubSettingsView }) => (
  <LabelledSection title="Granted repositories" titleClass="text-sm font-medium">
    <p className="-mt-2 text-sm text-muted">To add or remove one, change the App's installation on GitHub.</p>
    {settings.listingFailure ? (
      <ErrorMessage message={settings.listingFailure} />
    ) : settings.repositories.length === 0 ? (
      <p className={`${cardClass} px-4 py-6 text-center text-sm text-muted`}>The App is installed on no repository</p>
    ) : (
      <ul aria-label="Granted repositories" className={rowListClass}>
        {settings.repositories.map(({ fullName, defaultBranch }) => (
          <li key={fullName} className={rowClass}>
            <span className="min-w-0 flex-1 truncate font-medium">{fullName}</span>
            <span className="flex items-center gap-1 text-muted">
              <GitBranch aria-hidden className="size-3.5" />
              {defaultBranch}
            </span>
          </li>
        ))}
      </ul>
    )}
  </LabelledSection>
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
      <section aria-label="GitHub">
        <p className="text-sm text-muted">Loading…</p>
      </section>
    )
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const saved = await run(async () => show(await commands.saveGitHubSettings({ workspaceId, ...ids, ...secrets })))
    if (saved) setSecrets(noSecrets)
    setIsSaved(saved)
  }
  const placeholder = settings ? 'Set: enter a new value to replace it' : 'Not set'
  const toolsLink = mayManageTools ? (
    <Link to={`/w/${workspaceId}/settings/tools`} className="text-ink underline">
      Tools
    </Link>
  ) : (
    'Tools'
  )
  const manualToggle = (
    <button
      type="button"
      aria-expanded={isManual}
      className={settings ? ghostButtonClass : `self-start ${ghostButtonClass}`}
      onClick={() => setIsManual(!isManual)}
    >
      {settings ? 'Change the App credentials' : 'Create it manually'}
    </button>
  )
  return (
    <section aria-label="GitHub" className="flex max-w-3xl flex-col gap-6">
      {settings ? (
        <div role="status" className={rowListClass}>
          <SettingRow title="GitHub App connected" description="Dev chats clone, fetch and push through this App">
            <StatusBadge tone="ok">Connected</StatusBadge>
            {manualToggle}
          </SettingRow>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">
            Dev chats need a GitHub App to clone your repositories and open pull requests. Create it on GitHub in one
            step, then pick its repositories.
          </p>
          <GitHubAppCreationForm workspaceId={workspaceId} />
          {manualToggle}
        </div>
      )}
      {isManual && (
        <form onSubmit={submit} className={`${cardClass} flex flex-col gap-3 p-4`}>
          <GitHubAppGuide />
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
      )}
      {settings && (
        <>
          <GrantedRepositories settings={settings} />
          <MemberAccounts accounts={settings.memberAccounts} />
        </>
      )}
      <p className="text-sm text-muted">
        Who may use GitHub's tools, and which of them, is set with the other tools in {toolsLink}.
      </p>
    </section>
  )
}
