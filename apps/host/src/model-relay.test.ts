import { expect, test } from 'bun:test'
import { createModelRelay } from './model-relay.ts'

type Frame = Record<string, unknown>

const relayCollecting = (isConnected = true) => {
  const sent: Frame[] = []
  const relay = createModelRelay({ send: (frame) => isConnected && sent.push(frame) > 0 })
  const nextOf = async (type: string) => {
    for (const deadline = Date.now() + 5000; Date.now() < deadline; await Bun.sleep(5)) {
      const index = sent.findIndex((frame) => frame.type === type)
      if (index >= 0) return sent.splice(index, 1)[0] as Frame
    }
    throw new Error(`No ${type} frame`)
  }
  return { relay, sent, nextOf }
}
const completionRequest = () =>
  new Request('http://hq-gateway-relay:4000/v1/chat/completions?stream=true', {
    method: 'POST',
    headers: { authorization: 'Bearer runtime-token', 'content-type': 'application/json' },
    body: '{"model":"fake/fake-model"}',
  })

test('refuses anything outside /v1 without contacting HQ', async () => {
  const { relay, sent } = relayCollecting()
  for (const path of ['/api/providers', '/health', '/v2/chat', '/'])
    expect((await relay.fetch(new Request(`http://hq-gateway-relay:4000${path}`))).status).toBe(404)
  expect(sent).toEqual([])
})

test('relays a /v1 call to HQ and streams the answer chunk by chunk', async () => {
  const { relay, nextOf } = relayCollecting()
  const answer = relay.fetch(completionRequest())
  const request = await nextOf('gw_req')
  expect(request).toMatchObject({
    method: 'POST',
    path: '/v1/chat/completions?stream=true',
    body: '{"model":"fake/fake-model"}',
    headers: { authorization: 'Bearer runtime-token', 'content-type': 'application/json' },
  })
  relay.handle({ type: 'gw_head', sid: request.sid, status: 200, headers: { 'content-type': 'text/event-stream' } })
  const response = await answer
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/event-stream')
  const reader = response.body!.getReader()
  relay.handle({ type: 'gw_chunk', sid: request.sid, data: 'data: one\n\n' })
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: one\n\n')
  relay.handle({ type: 'gw_chunk', sid: request.sid, data: 'data: [DONE]\n\n' })
  relay.handle({ type: 'gw_end', sid: request.sid })
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: [DONE]\n\n')
  expect((await reader.read()).done).toBe(true)
})

test('answers 502 when HQ reports an error, when the socket closes or while disconnected', async () => {
  const { relay, nextOf } = relayCollecting()
  const failed = relay.fetch(completionRequest())
  relay.handle({ type: 'gw_error', sid: (await nextOf('gw_req')).sid })
  expect((await failed).status).toBe(502)
  expect(await (await failed).text()).toContain('The model gateway is unreachable')

  const pending = relay.fetch(completionRequest())
  await nextOf('gw_req')
  relay.closeAll()
  expect((await pending).status).toBe(502)

  expect((await relayCollecting(false).relay.fetch(completionRequest())).status).toBe(502)
})

test('tells HQ to cancel when the caller stops reading', async () => {
  const { relay, nextOf } = relayCollecting()
  const answer = relay.fetch(completionRequest())
  const { sid } = await nextOf('gw_req')
  relay.handle({ type: 'gw_head', sid, status: 200, headers: {} })
  await (await answer).body!.cancel()
  expect(await nextOf('gw_cancel')).toEqual({ type: 'gw_cancel', sid })
  relay.handle({ type: 'gw_chunk', sid, data: 'late' })
})
