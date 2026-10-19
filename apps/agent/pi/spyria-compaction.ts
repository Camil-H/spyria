import { compact, type ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default (pi: ExtensionAPI) =>
  pi.on('session_before_compact', async ({ preparation, customInstructions, signal }, context) => {
    const [provider = '', ...modelId] = (process.env.SPYRIA_COMPACTION_MODEL ?? '').split('/')
    const model = context.modelRegistry.find(provider, modelId.join('/'))
    const auth = model && (await context.modelRegistry.getApiKeyAndHeaders(model))
    if (!model || !auth?.ok) return
    return compact(preparation, model, auth.apiKey, auth.headers, customInstructions, signal).then(
      (compaction) => ({ compaction }),
      () => undefined,
    )
  })
