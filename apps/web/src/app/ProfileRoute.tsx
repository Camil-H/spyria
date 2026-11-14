import { ownedBy, type Snapshot } from '@spyria/db'
import { useQuery } from '@spyria/db/react'
import type { MemberId, WorkspaceId } from '@spyria/kernel'
import { ChecklistBlock } from '@spyria/onboarding'
import {
  AccountSection,
  ConnectionsSection,
  countConnectionStates,
  LlmAccessSection,
  ProfileHeader,
} from '@spyria/profile'
import { MyMachineSection, statusLabelOf } from '@spyria/runtime'
import { useSession } from '@spyria/session'
import { MyUsageSection } from '@spyria/usage'
import type { ComponentType } from 'react'
import { useOutletContext, useParams } from 'react-router'
import { CardGrid, CardPage, countLabelOf, type PageCard, pagePaddingClass } from './card-pages.tsx'

type ProfileCard = PageCard & { Page: ComponentType<{ workspaceId: WorkspaceId; memberId: MemberId }> }

const profileCards: readonly ProfileCard[] = [
  {
    path: 'account',
    title: 'Account',
    description: 'Your name, picture and where you are signed in',
    Page: AccountSection,
  },
  {
    path: 'llm-keys',
    title: 'LLM keys',
    description: 'Your own keys, used when you prompt',
    Page: LlmAccessSection,
  },
  {
    path: 'machine',
    title: 'My machine',
    description: 'Claude Code and Codex on your computer',
    Page: MyMachineSection,
  },
  {
    path: 'connections',
    title: 'Connections',
    description: 'GitHub and the tools agents use as you',
    Page: ConnectionsSection,
  },
  {
    path: 'usage',
    title: 'Usage',
    description: 'Your AI spend and monthly budget',
    isWide: true,
    Page: MyUsageSection,
  },
]

const cardStatusesOf =
  (workspaceId: WorkspaceId, memberId: MemberId) =>
  (snapshot: Snapshot): Readonly<Record<string, string>> => {
    const keyCount = snapshot.llmCredentials.filter(ownedBy(workspaceId, memberId)).length
    const machine = snapshot.runtimeHosts.find((host) => host.workspaceId === workspaceId && host.ownerId === memberId)
    const { connected, toReconnect } = countConnectionStates(workspaceId, memberId)(snapshot)
    return {
      'llm-keys': keyCount === 0 ? 'No key yet' : countLabelOf(keyCount, 'key'),
      machine: machine ? statusLabelOf(machine) : 'Not added',
      connections: toReconnect > 0 ? `${toReconnect} to reconnect` : `${connected} connected`,
    }
  }

const ProfileRoute = () => {
  const workspaceId = useOutletContext<WorkspaceId>()
  const { memberId } = useSession()
  const { card } = useParams()
  const statuses = useQuery(cardStatusesOf, workspaceId, memberId)
  const profilePath = `/w/${workspaceId}/profile`
  const openCard = profileCards.find(({ path }) => path === card)
  if (openCard)
    return (
      <CardPage backPath={profilePath} backLabel="Back to Profile" card={openCard}>
        <openCard.Page workspaceId={workspaceId} memberId={memberId} />
      </CardPage>
    )
  return (
    <div className={`flex flex-col gap-8 ${pagePaddingClass}`}>
      <h1 className="text-title">Profile</h1>
      <ProfileHeader workspaceId={workspaceId} memberId={memberId} />
      <ChecklistBlock workspaceId={workspaceId} scope="member" />
      <CardGrid basePath={profilePath} cards={profileCards} statusOf={(path) => statuses[path]} />
    </div>
  )
}

export default ProfileRoute
