import { expect, test } from 'bun:test'
import { bodyOf, branchOf, bumpsOf, publishedAfter, titleOf } from './bump-harnesses.ts'

test('only stable versions newer than the pin count, oldest first, so pre-releases and older lines are ignored', () => {
  const versions = ['2.1.310', '2.1.296', '2.1.290', '2.1.300-beta.1', '2.1.297', '0.169.0-linux-x64', '2.1.311-alpha']
  expect(publishedAfter(versions, '2.1.296')).toEqual(['2.1.297', '2.1.310'])
  expect(publishedAfter(['1.5.2', '0.74.2', '1.2.0'], '1.2.0')).toEqual(['1.5.2'])
})

test('a package already on its latest stable version is not bumped', () => {
  const bumps = bumpsOf(
    { '@anthropic-ai/claude-code': '2.1.296', '@agentclientprotocol/claude-agent-acp': '0.90.0' },
    {
      '@anthropic-ai/claude-code': ['2.1.296', '2.1.297', '2.1.310'],
      '@agentclientprotocol/claude-agent-acp': ['0.90.0', '0.91.0-preview.1'],
    },
  )
  expect(bumps).toEqual([
    { package: '@anthropic-ai/claude-code', from: '2.1.296', to: '2.1.310', published: ['2.1.297', '2.1.310'] },
  ])
})

test('the title names the program, or its adapter when only the adapter moved', () => {
  const program = { package: '@openai/codex', from: '0.162.1', to: '0.169.0', published: ['0.169.0'] }
  const adapter = { package: '@agentclientprotocol/codex-acp', from: '2.2.2', to: '2.6.0', published: ['2.6.0'] }
  expect(titleOf('codex', '@openai/codex', [adapter, program])).toBe('build: Codex 0.162.1 → 0.169.0')
  expect(titleOf('codex', '@openai/codex', [adapter])).toBe('build: Codex adapter 2.2.2 → 2.6.0')
  expect(branchOf('codex')).toBe('deps/harness-codex')
})

test('the description lists each package, links every release in between and ends with the manual checklist', () => {
  const body = bodyOf('codex', [
    { package: '@openai/codex', from: '0.162.1', to: '0.169.0', published: ['0.168.0', '0.169.0'] },
  ])
  expect(body).toContain('| `@openai/codex` | 0.162.1 | 0.169.0 |')
  expect(body).toContain(
    '[0.168.0](https://github.com/openai/codex/releases/tag/rust-v0.168.0), [0.169.0](https://github.com/openai/codex/releases/tag/rust-v0.169.0)',
  )
  expect(body).toContain('- [ ] On one machine, sign in to Codex with a real ChatGPT plan')
  expect(body).toContain('- [ ] Send one real prompt in a chat that runs on **Local · Codex**')
})
