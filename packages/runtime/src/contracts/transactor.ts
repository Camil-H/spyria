import type { JobQueue, RuntimeHostRepository, RuntimeRepository, RuntimeSecrets } from './repositories.ts'

export type UnitOfWork = {
  runtimeHosts: RuntimeHostRepository
  runtimes: RuntimeRepository
  secrets: RuntimeSecrets
  jobs: JobQueue
}

export type RuntimeTransactor = {
  run<Result>(work: (unitOfWork: UnitOfWork) => Promise<Result>): Promise<Result>
}
