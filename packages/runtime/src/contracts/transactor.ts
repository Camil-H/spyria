import type { Transactor } from '@spyria/kernel'
import type {
  JobQueue,
  RuntimeHostRepository,
  RuntimeRepository,
  RuntimeSecrets,
  WorkspaceSettings,
} from './repositories.ts'

export type UnitOfWork = {
  runtimeHosts: RuntimeHostRepository
  runtimes: RuntimeRepository
  secrets: RuntimeSecrets
  jobs: JobQueue
  workspaces: WorkspaceSettings
}

export type RuntimeTransactor = Transactor<UnitOfWork>
