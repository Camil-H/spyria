import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

const other = 'Other…'
const resultOf = (text: string) => ({ content: [{ type: 'text' as const, text }], details: {} })

export default (pi: ExtensionAPI) => {
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
}
