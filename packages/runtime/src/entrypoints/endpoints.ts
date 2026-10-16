import type { Transact, ZeroContext } from '@hq/db/zero-queries'
import { type RuntimeHostId, runtimeHostId, type WorkspaceId } from '@hq/kernel'
import type { Transaction } from '@rocicorp/zero'
import { z } from 'zod/mini'
import type { SandboxProvider } from '../contracts/sandbox-provider.ts'
import { assertAdmin, type HostDeclaration, type HostSystem } from '../domain/runtime-host.ts'
import { createTransactingZeroTransactor, createZeroTransactor } from '../integrations/zero-transactor.ts'
import { addRuntimeHost } from '../operations/add-runtime-host.ts'
import { claimRuntimeHost } from '../operations/claim-runtime-host.ts'
import { markHostOffline } from '../operations/mark-host-offline.ts'
import { reconcileHostRuntimes } from '../operations/reconcile-host-runtimes.ts'
import { recordHostHeartbeat } from '../operations/record-host-heartbeat.ts'
import { recordHostHello } from '../operations/record-host-hello.ts'
import { renewClaimCode } from '../operations/renew-claim-code.ts'

const dependenciesOf = (tx: Transaction) => ({ transactor: createZeroTransactor(tx) })
const textOf = (value: unknown) => (typeof value === 'string' ? value : '')

export const addRuntimeHostFromRequest = (tx: Transaction, context: ZeroContext, body: unknown) =>
  addRuntimeHost(dependenciesOf(tx), {
    id: crypto.randomUUID(),
    workspaceId: context.workspaceId,
    memberId: context.userId,
    role: context.role,
    name: textOf((body as Record<string, unknown> | null)?.name),
    personal: (body as Record<string, unknown> | null)?.personal === true,
    now: Date.now(),
  })

export const countMachinesFromRequest = async (tx: Transaction, context: ZeroContext) => {
  assertAdmin(context.role)
  const machines = await createZeroTransactor(tx).run(({ runtimeHosts }) =>
    runtimeHosts.listMachines(context.workspaceId),
  )
  return { count: machines.length }
}

export const renewClaimCodeFromRequest = (tx: Transaction, context: ZeroContext, hostId: string) =>
  renewClaimCode(dependenciesOf(tx), {
    workspaceId: context.workspaceId,
    memberId: context.userId,
    role: context.role,
    hostId: runtimeHostId(hostId),
    now: Date.now(),
  })

const boundedText = (maximumLength: number) => z.string().check(z.minLength(1), z.maxLength(maximumLength))
const count = z.number().check(z.nonnegative())
const signedIn = z.optional(z.array(boundedText(32)).check(z.maxLength(8)))
const hostSessionFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('claim'), code: boundedText(16) }),
  z.object({
    type: z.literal('hello'),
    token: boundedText(128),
    gatewayUrl: z.optional(z.url({ protocol: /^https?$/ }).check(z.maxLength(256))),
    system: z.object({
      cpus: count,
      memoryBytes: count,
      dockerVersion: boundedText(64),
      rootless: z.boolean(),
      cgroupDriver: boundedText(32),
      limitsEnforced: z.boolean(),
    }),
    personal: z.optional(z.boolean()),
    signedIn,
  }),
  z.object({
    type: z.literal('heartbeat'),
    memoryFreeBytes: count,
    running: z.int().check(z.nonnegative()),
    signedIn,
  }),
])

export type HostSessionFrame = z.infer<typeof hostSessionFrame>
export type ConnectedHost = { workspaceId: WorkspaceId; hostId: RuntimeHostId }

export const parseHostSessionFrame = (frame: unknown) => hostSessionFrame.safeParse(frame).data

export const createHostSessionHandlers = (transact: Transact) => ({
  claim: async (code: string) => {
    const outcome = await transact((tx) => claimRuntimeHost(dependenciesOf(tx), { code, now: Date.now() }))
    if ('refusal' in outcome) throw outcome.refusal
    return outcome
  },
  hello: (
    hello: Partial<HostDeclaration> & { token: string; system: HostSystem },
    beforeOnline: (host: ConnectedHost) => void,
  ) => transact((tx) => recordHostHello(dependenciesOf(tx), { ...hello, now: Date.now(), beforeOnline })),
  heartbeat: (host: ConnectedHost, heartbeat: { memoryFreeBytes: number; running: number; signedIn?: string[] }) =>
    transact((tx) => recordHostHeartbeat(dependenciesOf(tx), { ...host, ...heartbeat, now: Date.now() })),
  offline: (host: ConnectedHost) => transact((tx) => markHostOffline(dependenciesOf(tx), host)),
  reconcile: (host: ConnectedHost, provider: SandboxProvider) =>
    reconcileHostRuntimes(
      { transactor: createTransactingZeroTransactor(transact), provider },
      { ...host, now: Date.now() },
    ),
})
