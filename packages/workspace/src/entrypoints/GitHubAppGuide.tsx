import { CopyButton, ghostButtonClass } from '@spyria/ui'
import { githubCallbackPath, githubWebhooksPath } from '../domain/github.ts'

const permissions = [
  ['Contents', 'Read and write'],
  ['Pull requests', 'Read and write'],
  ['Checks', 'Read-only'],
  ['Metadata', 'Read-only'],
]
const events = [
  'Pull request',
  'Pull request review',
  'Pull request review comment',
  'Pull request review thread',
  'Check suite',
  'Check run',
]

export const GitHubAppGuide = ({ isOpen }: { isOpen: boolean }) => {
  const urls = [
    ['Homepage URL', location.origin],
    ['Callback URL', `${location.origin}${githubCallbackPath}`],
    ['Webhook URL', `${location.origin}${githubWebhooksPath}`],
  ] as const
  return (
    <details open={isOpen} className="text-sm">
      <summary className="cursor-pointer font-medium">How to create the GitHub App</summary>
      <ol className="mt-2 flex list-decimal flex-col gap-2 pl-5 text-muted">
        <li>
          On GitHub, open your organization's (or your account's) Settings › Developer settings › GitHub Apps › New
          GitHub App.
        </li>
        <li>
          Enter these values:
          <dl className="mt-1 grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1">
            {urls.map(([name, url]) => (
              <div key={name} className="contents">
                <dt>{name}</dt>
                <dd className="font-mono text-xs break-all text-ink">{url}</dd>
                <dd>
                  <CopyButton text={url} label={`Copy ${name}`} className={ghostButtonClass} />
                </dd>
              </div>
            ))}
          </dl>
          Keep "Expire user authorization tokens" checked, leave "Request user authorization (OAuth) during
          installation" unchecked and the Setup URL empty. Keep the webhook active and choose a long random webhook
          secret.
        </li>
        <li>
          Repository permissions: {permissions.map(([name, access]) => `${name}: ${access}`).join(', ')}. No
          organization or account permissions.
        </li>
        <li>Subscribe to events: {events.join(', ')}.</li>
        <li>
          Create the App, then fill this form: App id and Client id from the App's General page, Client secret from
          "Generate a new client secret", Private key from "Generate a private key" (paste the whole .pem file), and the
          webhook secret you chose.
        </li>
        <li>Install the App on the repositories Spyria may use: they appear below as granted repositories.</li>
      </ol>
    </details>
  )
}
