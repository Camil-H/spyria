import type { ZeroContext } from '@hq/db/zero-queries'
import { type RuntimeHostId, runtimeHostId, type WorkspaceId } from '@hq/kernel'
import type { Transaction } from '@rocicorp/zero'
import { z } from 'zod/mini'
import type { SandboxProvider } from '../contracts/sandbox-provider.ts'
import type { HostSystem } from '../domain/runtime-host.ts'
import {
  createTransactingZeroTransactor,
  createZeroTransactor,
  type Transact,
} from '../integrations/zero-transactor.ts'
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
    now: Date.now(),
  })

export const renewClaimCodeFromRequest = (tx: Transaction, context: ZeroContext, hostId: string) =>
  renewClaimCode(dependenciesOf(tx), {
    workspaceId: context.workspaceId,
    role: context.role,
    hostId: runtimeHostId(hostId),
    now: Date.now(),
  })

const boundedText = (maximumLength: number) => z.string().check(z.minLength(1), z.maxLength(maximumLength))
const count = z.number().check(z.nonnegative())
const hostSessionFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('claim'), code: boundedText(16) }),
  z.object({
    type: z.literal('hello'),
    token: boundedText(128),
    system: z.object({
      cpus: count,
      memoryBytes: count,
      dockerVersion: boundedText(64),
      rootless: z.boolean(),
      cgroupDriver: boundedText(32),
      limitsEnforced: z.boolean(),
    }),
  }),
  z.object({ type: z.literal('heartbeat'), memoryFreeBytes: count, running: z.int().check(z.nonnegative()) }),
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
  hello: (hello: { token: string; system: HostSystem }) =>
    transact((tx) => recordHostHello(dependenciesOf(tx), { ...hello, now: Date.now() })),
  heartbeat: (host: ConnectedHost, heartbeat: { memoryFreeBytes: number; running: number }) =>
    transact((tx) => recordHostHeartbeat(dependenciesOf(tx), { ...host, ...heartbeat, now: Date.now() })),
  offline: (host: ConnectedHost) => transact((tx) => markHostOffline(dependenciesOf(tx), host)),
  reconcile: (host: ConnectedHost, provider: SandboxProvider) =>
    reconcileHostRuntimes(
      { transactor: createTransactingZeroTransactor(transact), provider },
      { ...host, now: Date.now() },
    ),
})
