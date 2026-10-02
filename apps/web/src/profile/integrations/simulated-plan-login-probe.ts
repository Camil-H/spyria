import type { PlanLoginProbe } from '../contracts/plan-login-probe.ts'

const knownHarnesses = ['Claude Code', 'Codex', 'Gemini CLI']

export const createSimulatedPlanLoginProbe = (): PlanLoginProbe => ({
  verify: async ({ harness }) => (knownHarnesses.includes(harness) ? 'Verified' : 'Not verified'),
})
