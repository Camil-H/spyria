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
  pi.registerTool({
    name: 'open_page',
    label: 'Open',
    description:
      "Open a page in the member's Browser panel: an http or https address, or the path of a file in the project such as an HTML report you wrote.",
    promptGuidelines: [
      'When you build something the member should look at, such as a report or a page, open it with open_page.',
    ],
    parameters: Type.Object({ address: Type.String(), title: Type.Optional(Type.String()) }),
    execute: async () => resultOf("The page is open in the member's Browser panel."),
  })
}
