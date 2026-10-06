import type { FakeAgentServer } from '../testing.ts'

export type Event = { id: string; kind: string; timestamp: string; [field: string]: unknown }
export type Conversation = {
  id: string
  apiKey: string
  created: Record<string, unknown>
  events: Event[]
  executionStatus: string
  listeners: Set<(event: Event) => void>
  closers: Set<() => void>
}
type Turn = (conversation: Conversation, text: string) => Promise<void>

export const text = (value: string) => [{ type: 'text', text: value }]
export const replyText = 'Understood, working on it.'

export const createFakeAgentServer = () => {
  const conversations = new Map<string, Conversation>()
  const prompts: { conversationId: string; text: string }[] = []
  const connections: { conversationId: string; query: string; auth: unknown }[] = []
  const interrupts: string[] = []
  let clock = 0
  const emit = (conversation: Conversation, kind: string, fields: Record<string, unknown> = {}, repeat = 1) => {
    const event = {
      id: crypto.randomUUID(),
      kind,
      timestamp: `2026-10-05T20:00:00.${String(++clock).padStart(6, '0')}`,
      ...fields,
    }
    if (kind !== 'StreamingDeltaEvent') conversation.events.push(event)
    for (let sent = 0; sent < repeat; sent++) for (const listener of conversation.listeners) listener(event)
    return event
  }
  const status = (conversation: Conversation, value: string) => {
    conversation.executionStatus = value
    return emit(conversation, 'ConversationStateUpdateEvent', { source: 'environment', key: 'execution_status', value })
  }
  const beginTurn = async (conversation: Conversation, prompt: string) => {
    emit(conversation, 'MessageEvent', { source: 'user', llm_message: { role: 'user', content: text(prompt) } })
    status(conversation, 'running')
    for (const word of replyText.split(/(?<= )/)) {
      await Bun.sleep(5)
      emit(conversation, 'StreamingDeltaEvent', { source: 'agent', content: word })
    }
  }
  const finishTurn = (conversation: Conversation, repeat = 1) => {
    emit(
      conversation,
      'MessageEvent',
      { source: 'agent', llm_message: { role: 'assistant', content: text(replyText) } },
      repeat,
    )
    status(conversation, 'finished')
  }
  const defaultTurn: Turn = async (conversation, prompt) => {
    await beginTurn(conversation, prompt)
    finishTurn(conversation)
  }
  const fake = {
    conversations,
    prompts,
    connections,
    interrupts,
    turn: defaultTurn,
    onInterrupt: (conversation: Conversation) => {
      status(conversation, 'paused')
    },
    emit,
    status,
    beginTurn,
    finishTurn,
    agentServer: {
      respond: ({ method, path, headers, body }, container) => {
        if (headers?.['x-session-api-key'] !== container.apiKey) return { status: 401, body: '' }
        if (method === 'POST' && path === '/api/conversations') {
          const id = crypto.randomUUID()
          conversations.set(id, {
            id,
            apiKey: container.apiKey,
            created: JSON.parse(body ?? '{}'),
            events: [],
            executionStatus: 'idle',
            listeners: new Set(),
            closers: new Set(),
          })
          return { status: 201, body: JSON.stringify({ id, execution_status: 'idle' }) }
        }
        const [, conversationId = '', action = ''] = path.match(/^\/api\/conversations\/([^/]+)\/?(.*)$/) ?? []
        const conversation = conversations.get(conversationId)
        if (!conversation) return { status: 404, body: '' }
        if (method === 'GET' && action === '')
          return {
            status: 200,
            body: JSON.stringify({ id: conversation.id, execution_status: conversation.executionStatus }),
          }
        if (method === 'POST' && action === 'interrupt') {
          interrupts.push(conversation.id)
          fake.onInterrupt(conversation)
          return { status: 200, body: JSON.stringify({ success: true }) }
        }
        if (method !== 'POST' || action !== 'events') return { status: 404, body: '' }
        const prompt = (JSON.parse(body ?? '{}') as { content: { text: string }[] }).content[0]?.text ?? ''
        prompts.push({ conversationId: conversation.id, text: prompt })
        void fake.turn(conversation, prompt)
        return { status: 200, body: JSON.stringify({ success: true }) }
      },
      connect: ({ path, send, close }) => {
        const url = new URL(path, 'http://agent-server')
        const conversation = conversations.get(url.pathname.split('/').at(-1) ?? '')
        const listener = (event: Event) => send(JSON.stringify(event))
        if (conversation) conversation.closers.add(close)
        return {
          onMessage: (data) => {
            if (!conversation || conversation.listeners.has(listener)) return
            const auth = JSON.parse(data)
            connections.push({ conversationId: conversation.id, query: url.search, auth })
            if (auth.session_api_key !== conversation.apiKey) return close()
            const fullState = { kind: 'ConversationStateUpdateEvent', key: 'full_state', value: {} }
            send(JSON.stringify({ id: crypto.randomUUID(), timestamp: '2026-10-05T20:00:00.000000', ...fullState }))
            const after = url.searchParams.get('after_timestamp') ?? ''
            if (url.searchParams.get('resend_mode') === 'all') conversation.events.forEach(listener)
            if (url.searchParams.get('resend_mode') === 'since')
              for (const event of conversation.events) if (event.timestamp >= after) listener(event)
            conversation.listeners.add(listener)
          },
          onClose: () => {
            conversation?.listeners.delete(listener)
            conversation?.closers.delete(close)
          },
        }
      },
    } satisfies FakeAgentServer,
  }
  return fake
}

export type FakeAgent = ReturnType<typeof createFakeAgentServer>
