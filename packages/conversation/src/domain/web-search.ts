import { chatModelsOf, cheapestModelOf, type Model } from '@spyria/kernel'

type Source = Readonly<{ url: string; title: string }>
type ResponseItem = {
  type?: string
  content?: { type?: string; text?: string; annotations?: { type?: string; url?: string; title?: string }[] }[]
  action?: { sources?: { url?: string; title?: string }[] }
}

export const webToolsPath = '/mcp/web'
export const webSearchPath = '/v1/responses'
const maximumQueryLength = 400
const maximumOutputTokens = 2048
const maximumSources = 10
const searchingProviders = ['anthropic/', 'openai/', 'gemini/']
const searchlessModels = /-nano\b/

export const webSearchTool = {
  name: 'web_search',
  description:
    'Search the web for current information, such as documentation, release notes, prices or news. Answers with what the results say and the addresses of its sources; open a source with open_page or read it with curl when you need the whole page.',
  inputSchema: {
    type: 'object',
    required: ['query'],
    properties: { query: { type: 'string', description: 'What to search for, in a few words or a question' } },
  },
  annotations: { readOnlyHint: true },
}

export const webSearchUnavailable =
  'Web search needs an Anthropic, OpenAI or Gemini model among the models of the member who prompted'
export const webSearchOverBudget = 'Web search was not run: the budget of the member who prompted is used up'
export const webSearchFailedOf = (reason: string | undefined) =>
  reason ? `The web search failed: ${reason.slice(0, 300)}` : 'The web search failed'
export const webSearchNotRun = 'The model did not search the web; it may not offer web search through this gateway'

export const webSearchQueryOf = (input: unknown): string | { refusal: string } => {
  const query = (input as { query?: unknown } | undefined)?.query
  const text = typeof query === 'string' ? query.trim() : ''
  if (text === '') return { refusal: 'Give the words to search for' }
  if (text.length > maximumQueryLength) return { refusal: `The query is longer than ${maximumQueryLength} characters` }
  return text
}

export const webSearchModelOf = (reachable: readonly Model[]) =>
  cheapestModelOf(
    chatModelsOf(reachable).filter(
      ({ id }) => searchingProviders.some((provider) => id.startsWith(provider)) && !searchlessModels.test(id),
    ),
  )?.id

export const webSearchRequestOf = (model: string, query: string) => ({
  model,
  instructions:
    'Search the web to answer. Reply with the facts the results give, briefly, and say when the results disagree or do not answer.',
  input: query,
  tools: [{ type: 'web_search' }],
  max_output_tokens: maximumOutputTokens,
})

const uniqueSources = (sources: readonly Source[]) =>
  sources
    .filter((source, index) => sources.findIndex(({ url }) => url === source.url) === index)
    .slice(0, maximumSources)

export const webSearchAnswerOf = (response: unknown) => {
  const output = ((response as { output?: unknown } | undefined)?.output ?? []) as ResponseItem[]
  if (!Array.isArray(output) || !output.some(({ type }) => type === 'web_search_call')) return undefined
  const texts = output.flatMap(({ type, content }) =>
    type === 'message' ? (content ?? []).filter((part) => part.type === 'output_text') : [],
  )
  const cited = texts.flatMap(({ annotations }) => annotations ?? []).filter(({ type }) => type === 'url_citation')
  const searched = output.flatMap(({ action }) => action?.sources ?? [])
  const sources = uniqueSources(
    [...cited, ...searched].flatMap(({ url, title }) => (url ? [{ url, title: title || url }] : [])),
  )
  const answer =
    texts
      .map(({ text }) => text ?? '')
      .join('')
      .trim() || 'The search found nothing to say.'
  if (sources.length === 0) return answer
  return `${answer}\n\nSources:\n${sources.map(({ url, title }) => `- ${title}: ${url}`).join('\n')}`
}
