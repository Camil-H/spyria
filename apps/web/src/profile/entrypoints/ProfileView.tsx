import { useQuery } from '@hq/db'
import type { WorkspaceId } from '@hq/kernel'
import { useOutletContext } from 'react-router'
import { useSession } from '../../app/session.tsx'
import { getProfile } from '../queries/get-profile.ts'
import { ConnectionsSection } from './ConnectionsSection.tsx'
import { DisplayNameForm } from './DisplayNameForm.tsx'
import { LlmAccessSection } from './LlmAccessSection.tsx'
import { Section } from './Section.tsx'

export const ProfileView = () => {
  const workspaceId = useOutletContext<WorkspaceId>()
  const { memberId } = useSession()
  const profile = useQuery(getProfile(workspaceId, memberId))
  if (!profile) return null
  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <header>
        <h1 className="text-2xl font-semibold">Profile</h1>
        <p className="mt-2 text-muted">{profile.name}</p>
      </header>
      <Section title="Display name">
        <DisplayNameForm workspaceId={workspaceId} memberId={memberId} currentName={profile.name} />
      </Section>
      <LlmAccessSection workspaceId={workspaceId} memberId={memberId} />
      <ConnectionsSection workspaceId={workspaceId} memberId={memberId} />
    </div>
  )
}
