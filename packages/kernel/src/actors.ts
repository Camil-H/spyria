import type { ChatId, MemberId } from './ids.ts'
import { memberId } from './ids.ts'

export const actorKinds = ['member', 'agent', 'system', 'integration'] as const
export type ActorKind = (typeof actorKinds)[number]
export type Integration = 'github'

export type Actor =
  | Readonly<{ kind: 'member'; id: MemberId }>
  | Readonly<{ kind: 'agent'; id: string; onBehalfOf: MemberId | null }>
  | Readonly<{ kind: 'system'; id: string; onBehalfOf: MemberId | null }>
  | Readonly<{ kind: 'integration'; id: Integration; onBehalfOf: MemberId | null }>

export type StoredActor = { kind: string | null; id: string | null; onBehalfOf: string | null }

export const memberActor = (id: MemberId): Actor => ({ kind: 'member', id })
export const agentActor = (runtimeChatId: ChatId, onBehalfOf: MemberId | null): Actor => ({
  kind: 'agent',
  id: runtimeChatId,
  onBehalfOf,
})
export const systemActor = (job: string, onBehalfOf: MemberId | null = null): Actor => ({
  kind: 'system',
  id: job,
  onBehalfOf,
})
export const integrationActor = (integration: Integration, onBehalfOf: MemberId | null = null): Actor => ({
  kind: 'integration',
  id: integration,
  onBehalfOf,
})

export const memberBehind = (actor: Actor) => (actor.kind === 'member' ? actor.id : actor.onBehalfOf)
export const actingMemberOf = (actor: Actor) => (actor.kind === 'member' ? actor.id : null)

export const storedActorOf = (actor: Actor) => ({
  kind: actor.kind,
  id: actor.id,
  onBehalfOf: actor.kind === 'member' ? null : actor.onBehalfOf,
})

const isActorKind = (kind: string): kind is ActorKind => (actorKinds as readonly string[]).includes(kind)

export const actorOf = ({ kind, id, onBehalfOf }: StoredActor): Actor => {
  const behalf = onBehalfOf === null ? null : memberId(onBehalfOf)
  if (kind === null || !isActorKind(kind))
    return id === null ? systemActor('unknown', behalf) : memberActor(memberId(id))
  if (kind === 'member') return memberActor(memberId(id ?? ''))
  if (kind === 'integration') return integrationActor(id as Integration, behalf)
  return { kind, id: id ?? 'unknown', onBehalfOf: behalf }
}
