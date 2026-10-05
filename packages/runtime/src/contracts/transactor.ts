import type { JobQueue, RuntimeApiKeys, RuntimeHostRepository, RuntimeRepository } from './repositories.ts'

export type UnitOfWork = {
  runtimeHosts: RuntimeHostRepository
  runtimes: RuntimeRepository
  apiKeys: RuntimeApiKeys
  jobs: JobQueue
}

export type RuntimeTransactor = {
  run<Result>(work: (unitOfWork: UnitOfWork) => Promise<Result>): Promise<Result>
}
