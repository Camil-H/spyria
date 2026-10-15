import type { ExtensionAPI, ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

const other = 'Other…'
const readOnly = /^\s*(cat|head|tail|ls|pwd|grep|rg|find|wc|git (status|log|diff|show)|sed -n|echo)\b[^>;&|`$]*$/
const resultOf = (text: string) => ({ content: [{ type: 'text' as const, text }], details: {} })

export default (pi: ExtensionAPI) => {
  let isPlanning = false
  const setPlanning = (ui: ExtensionUIContext, value: boolean) => {
    isPlanning = value
    ui.setStatus('hq-plan', value ? 'plan' : 'default')
  }
  pi.registerCommand('hq-plan', {
    description: 'Plan mode: on or off',
    handler: async (mode, context) => setPlanning(context.ui, mode.trim() === 'on'),
  })
  pi.registerTool({
    name: 'ask_member',
    label: 'Ask',
    description: 'Ask the member a question with suggested answers; they may also answer freely.',
    parameters: Type.Object({ question: Type.String(), options: Type.Array(Type.String()) }),
    async execute(_id, { question, options }, _signal, _update, context) {
      const choice = await context.ui.select(question, [...options, other])
      const answer = choice === other ? await context.ui.input(question) : choice
      return resultOf(answer ? `The member answered: ${answer}` : 'The member did not answer.')
    },
  })
  pi.registerTool({
    name: 'propose_plan',
    label: 'Plan',
    description: 'In plan mode, propose the plan for approval before making changes.',
    parameters: Type.Object({ plan: Type.String() }),
    async execute(_id, { plan }, _signal, _update, context) {
      if (!(await context.ui.confirm('Approve the plan?', plan))) return resultOf('The member wants to keep planning.')
      setPlanning(context.ui, false)
      return resultOf('The member approved the plan. Plan mode is off: carry it out.')
    },
  })
  pi.on('tool_call', async ({ toolName, input }) => {
    if (
      isPlanning &&
      (['edit', 'write'].includes(toolName) || (toolName === 'bash' && !readOnly.test(String(input.command))))
    )
      return { block: true, reason: 'Plan mode: read only. Propose the plan with propose_plan first.' }
  })
  pi.on('before_agent_start', async () =>
    isPlanning
      ? {
          message: {
            customType: 'hq-plan',
            content: 'Plan mode: read only. When ready, call propose_plan.',
            display: false,
          },
        }
      : undefined,
  )
}
