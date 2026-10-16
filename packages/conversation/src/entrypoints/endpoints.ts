import { z } from 'zod/mini'

const questionAnswer = z.union([
  z.object({ approve: z.boolean() }),
  z.object({
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
    free: z.optional(z.record(z.string(), z.string())),
  }),
])
export type QuestionAnswer = z.infer<typeof questionAnswer>
const planMode = z.object({ enabled: z.boolean() })

export const questionAnswerOf = (body: unknown) => questionAnswer.safeParse(body).data
export const planModeOf = (body: unknown) => planMode.safeParse(body).data
