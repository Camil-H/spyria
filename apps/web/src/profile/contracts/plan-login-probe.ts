import type { Secret } from '../domain/secret.ts'

export type PlanLoginProbe = {
  verify(login: { harness: string; credential: Secret }): Promise<'Verified' | 'Not verified'>
}
