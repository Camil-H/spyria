import type { WorkspaceId } from '@spyria/kernel'
import { buttonClass, ErrorMessage, fieldClass, labelClass, SegmentedChoice, useGuardedAction } from '@spyria/ui'
import { type SubmitEvent, useState } from 'react'
import { useWorkspaceCommands } from './providers.tsx'

type AppOwner = 'account' | 'organization'

const ownerLabels: Record<AppOwner, string> = { account: 'Private account', organization: 'An organization' }

const postManifestTo = (formAction: string, manifest: string) => {
  const form = Object.assign(document.createElement('form'), { method: 'post', action: formAction })
  form.append(Object.assign(document.createElement('input'), { type: 'hidden', name: 'manifest', value: manifest }))
  document.body.append(form)
  form.submit()
}

export const GitHubAppCreationForm = ({ workspaceId }: { workspaceId: WorkspaceId }) => {
  const commands = useWorkspaceCommands()
  const [owner, setOwner] = useState<AppOwner>('account')
  const [organization, setOrganization] = useState('')
  const { errorMessage, isPending, run } = useGuardedAction()
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    return run(async () => {
      const { formAction, manifest } = await commands.startGitHubAppCreation({
        workspaceId,
        organization: owner === 'organization' ? organization : '',
      })
      postManifestTo(formAction, manifest)
    })
  }
  return (
    <form onSubmit={submit} aria-label="Create the GitHub App" className="flex flex-col">
      <div className="self-start">
        <SegmentedChoice
          label="Owner"
          name="github-app-owner"
          options={['account', 'organization']}
          labels={ownerLabels}
          value={owner}
          onChange={setOwner}
        />
      </div>
      <div className="mt-2 flex flex-col gap-3 rounded-lg border border-line p-4">
        {owner === 'account' ? (
          <p className="text-sm text-muted">
            GitHub creates the App under your own GitHub account, with Spyria's permissions, events and URLs; then you
            pick its repositories.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted">
              GitHub creates the App in the organization, with Spyria's permissions, events and URLs; then you pick its
              repositories. You need to be an owner or a GitHub App manager of the organization.
            </p>
            <label className={labelClass}>
              Organization login
              <input
                className={fieldClass}
                required
                value={organization}
                onChange={(event) => setOrganization(event.target.value)}
              />
            </label>
          </>
        )}
        <ErrorMessage message={errorMessage} />
        <div>
          <button type="submit" className={buttonClass} disabled={isPending}>
            Create the GitHub App on GitHub
          </button>
        </div>
      </div>
    </form>
  )
}
