import type { Transaction } from '@rocicorp/zero'
import type { Transact, ZeroContext } from '@spyria/db/zero-queries'
import { type MemberId, type RuntimeHostId, requirePermissionIn, runtimeHostId, type WorkspaceId } from '@spyria/kernel'
import { z } from 'zod/mini'
import type { SandboxProvider } from '../contracts/sandbox-provider.ts'
import type { HostDeclaration, HostSystem, RuntimeHost } from '../domain/runtime-host.ts'
import {
  contextPermissionsOf,
  createTransactingZeroTransactor,
  createZeroTransactor,
} from '../integrations/zero-transactor.ts'
import { addInstallHost } from '../operations/add-install-host.ts'
import { addRuntimeHost } from '../operations/add-runtime-host.ts'
import { claimRuntimeHost } from '../operations/claim-runtime-host.ts'
import { discardUnknownRuntimes } from '../operations/discard-unknown-runtimes.ts'
import { markHostOffline } from '../operations/mark-host-offline.ts'
import { reconcileHostRuntimes } from '../operations/reconcile-host-runtimes.ts'
import { recordHostHeartbeat } from '../operations/record-host-heartbeat.ts'
import { recordHostHello } from '../operations/record-host-hello.ts'
import { renewClaimCode } from '../operations/renew-claim-code.ts'

const dependenciesOf = (tx: Transaction) => ({ transactor: createZeroTransactor(tx) })
const textOf = (value: unknown) => (typeof value === 'string' ? value : '')

export const addRuntimeHostFromRequest = async (tx: Transaction, context: ZeroContext, body: unknown) =>
  addRuntimeHost(dependenciesOf(tx), {
    id: crypto.randomUUID(),
    workspaceId: context.workspaceId,
    memberId: context.userId,
    permissions: await contextPermissionsOf(tx, context),
    name: textOf((body as Record<string, unknown> | null)?.name),
    personal: (body as Record<string, unknown> | null)?.personal === true,
    now: Date.now(),
  })

export const addInstallHostIn = (
  tx: Transaction,
  input: { workspaceId: WorkspaceId; memberId: MemberId; installHostToken: string },
) => addInstallHost(dependenciesOf(tx), { ...input, id: crypto.randomUUID(), now: Date.now() })

export const renewClaimCodeFromRequest = async (tx: Transaction, context: ZeroContext, hostId: string) =>
  renewClaimCode(dependenciesOf(tx), {
    workspaceId: context.workspaceId,
    memberId: context.userId,
    permissions: await contextPermissionsOf(tx, context),
    hostId: runtimeHostId(hostId),
    now: Date.now(),
  })

const boundedText = (maximumLength: number) => z.string().check(z.minLength(1), z.maxLength(maximumLength))
const count = z.number().check(z.nonnegative())
const maximumHeartbeatMilliseconds = 24 * 60 * 60_000
const signedIn = z.optional(z.array(boundedText(32)).check(z.maxLength(8)))
const credentialsChangedAt = z.optional(
  z.record(boundedText(32), count).check(z.refine((changes) => Object.keys(changes).length <= 8)),
)
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
    hostVersion: z.optional(boundedText(64)),
    protocolVersion: z.optional(z.int().check(z.nonnegative())),
    heartbeatMilliseconds: z.optional(z.int().check(z.positive(), z.lte(maximumHeartbeatMilliseconds))),
    signedIn,
    credentialsChangedAt,
  }),
  z.object({
    type: z.literal('heartbeat'),
    memoryFreeBytes: count,
    running: z.int().check(z.nonnegative()),
    signedIn,
    credentialsChangedAt,
  }),
])

export type HostSessionFrame = z.infer<typeof hostSessionFrame>
export type ConnectedHost = { workspaceId: WorkspaceId; hostId: RuntimeHostId }

export const parseHostSessionFrame = (frame: unknown) => hostSessionFrame.safeParse(frame).data

export const createHostSessionHandlers = (
  transact: Transact,
  { hostUpdateCommandOf }: { hostUpdateCommandOf?: (host: RuntimeHost) => string } = {},
) => ({
  claim: async (code: string) => {
    const outcome = await transact((tx) => claimRuntimeHost(dependenciesOf(tx), { code, now: Date.now() }))
    if ('refusal' in outcome) throw outcome.refusal
    return outcome
  },
  hello: async (
    hello: Partial<HostDeclaration> & {
      token: string
      system: HostSystem
      hostVersion?: string
      protocolVersion?: number
      heartbeatMilliseconds?: number
    },
    beforeOnline: (host: ConnectedHost) => void,
  ) => {
    const outcome = await transact((tx) =>
      recordHostHello(dependenciesOf(tx), {
        ...hello,
        now: Date.now(),
        beforeOnline,
        updateCommandOf: hostUpdateCommandOf,
      }),
    )
    if ('refusal' in outcome) throw outcome.refusal
    return outcome
  },
  heartbeat: (
    host: ConnectedHost,
    heartbeat: { memoryFreeBytes: number; running: number } & Partial<Omit<HostDeclaration, 'personal'>>,
  ) => transact((tx) => recordHostHeartbeat(dependenciesOf(tx), { ...host, ...heartbeat, now: Date.now() })),
  offline: (host: ConnectedHost) => transact((tx) => markHostOffline(dependenciesOf(tx), host)),
  reconcile: (host: ConnectedHost, provider: SandboxProvider) =>
    reconcileHostRuntimes(
      { transactor: createTransactingZeroTransactor(transact), provider },
      { ...host, now: Date.now() },
    ),
  discardUnknown: (host: ConnectedHost, provider: SandboxProvider) =>
    discardUnknownRuntimes({ transactor: createTransactingZeroTransactor(transact), provider }, host),
})
