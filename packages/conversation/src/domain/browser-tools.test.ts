import { expect, test } from 'bun:test'
import {
  browserAnswerOf,
  browserAsleepRefusal,
  browserCommandOf,
  browserDownloadOf,
  browserStartFailureOf,
  contentDispositionOf,
  imageFileOf,
  memberMessageOf,
  submitCheckOf,
  visitedAddressOf,
} from './browser-tools.ts'

const commandOf = (name: string, input: unknown) => {
  const parsed = browserCommandOf(name, input)
  return 'refusal' in parsed ? parsed : parsed.browserCommand
}

test('each browser tool becomes one command of the browser, with only the fields it knows', () => {
  expect(commandOf('browser_snapshot', { extra: 1 })).toEqual({ command: 'snapshot' })
  expect(commandOf('browser_click', { ref: 'e5', command: 'evaluate' })).toEqual({
    command: 'click',
    ref: 'e5',
    double: false,
  })
  expect(commandOf('browser_type', { ref: 'f1e3', text: 'hello', submit: true })).toEqual({
    command: 'type',
    ref: 'f1e3',
    text: 'hello',
    submit: true,
  })
  expect(commandOf('browser_fill', { ref: 'e2', value: '' })).toEqual({ command: 'fill', ref: 'e2', value: '' })
  expect(commandOf('browser_press', { key: 'Control+A' })).toEqual({ command: 'press', key: 'Control+A' })
  expect(commandOf('browser_run_javascript', { expression: 'document.title' })).toEqual({
    command: 'evaluate',
    expression: 'document.title',
  })
  expect(commandOf('browser_wait', { text: 'Done', seconds: 90 })).toEqual({
    command: 'wait',
    text: 'Done',
    seconds: 30,
  })
  expect(commandOf('browser_navigate', { direction: 'back' })).toEqual({ command: 'navigate', direction: 'back' })
  expect(commandOf('browser_screenshot', {})).toEqual({ command: 'screenshot', fullPage: false })
})

test('a browser tool call with a missing or invalid field is refused with what to give', () => {
  expect(commandOf('browser_click', { ref: 'e5"]' })).toEqual({
    refusal: 'Give the ref of an element from the latest browser_snapshot, such as e5',
  })
  expect(commandOf('browser_type', { ref: 'e1', text: 'x'.repeat(10_001) })).toEqual({
    refusal: 'Give the text to type, at most 10000 characters',
  })
  expect(commandOf('browser_press', { key: 'Enter\n' })).toMatchObject({ refusal: expect.any(String) })
  expect(commandOf('browser_run_javascript', { expression: '  ' })).toMatchObject({ refusal: expect.any(String) })
  expect(commandOf('browser_wait', {})).toEqual({ refusal: 'Give a text to wait for or a number of seconds' })
  expect(commandOf('browser_navigate', { direction: 'home' })).toEqual({
    refusal: 'Give the direction: back, forward or reload',
  })
  expect(commandOf('browser_unknown', {})).toEqual({ refusal: 'Unknown tool' })
})

test('running a script or submitting asks first; a click or a key press asks only when it submits; reading never asks', () => {
  expect(submitCheckOf({ command: 'evaluate', expression: '1' })).toBe('always')
  expect(submitCheckOf({ command: 'type', ref: 'e1', text: 'x', submit: true })).toBe('always')
  expect(submitCheckOf({ command: 'type', ref: 'e1', text: 'x', submit: false })).toBe('never')
  expect(submitCheckOf({ command: 'click', ref: 'e5', double: false })).toEqual({
    command: 'would_submit',
    action: 'click',
    ref: 'e5',
  })
  expect(submitCheckOf({ command: 'press', key: 'Enter', ref: 'e2' })).toEqual({
    command: 'would_submit',
    action: 'press',
    ref: 'e2',
    key: 'Enter',
  })
  expect(submitCheckOf({ command: 'type', ref: 'e1', text: 'x\n', submit: false })).toBe('always')
  for (const key of ['Enter', 'NumpadEnter', 'Control+Enter', 'Space', ' '])
    expect(submitCheckOf({ command: 'press', key })).toBe('always')
  expect(submitCheckOf({ command: 'press', key: 'Space', ref: 'e4' })).toEqual({
    command: 'would_submit',
    action: 'press',
    ref: 'e4',
    key: 'Space',
  })
  for (const key of ['Escape', 'ArrowDown', 'Control+A']) {
    expect(submitCheckOf({ command: 'press', key })).toBe('never')
    expect(submitCheckOf({ command: 'press', key, ref: 'e4' })).toBe('never')
  }
  for (const command of ['snapshot', 'fill', 'wait', 'navigate', 'screenshot', 'open'])
    expect(submitCheckOf({ command })).toBe('never')
})

test("a member's message reaches their browser only as a known action, with only the fields that action reads", () => {
  expect(memberMessageOf({ type: 'input', command: 'evaluate', expression: 'steal()' })).toBeUndefined()
  expect(memberMessageOf({ type: 'evaluate', expression: '1' })).toBeUndefined()
  expect(
    memberMessageOf({
      type: 'input',
      event: { kind: 'mouse', action: 'down', x: 10, y: 20, button: 'right', clickCount: 1, shift: true, id: 3 },
    }),
  ).toEqual({
    type: 'input',
    event: {
      kind: 'mouse',
      action: 'down',
      x: 10,
      y: 20,
      button: 'right',
      clickCount: 1,
      deltaX: 0,
      deltaY: 0,
      alt: false,
      control: false,
      meta: false,
      shift: true,
    },
  })
  expect(memberMessageOf({ type: 'input', event: { kind: 'key', action: 'down', key: 'a', command: 'x' } })).toEqual({
    type: 'input',
    event: { kind: 'key', action: 'down', key: 'a' },
  })
  expect(memberMessageOf({ type: 'input', event: { kind: 'text', text: 'pasted' } })).toEqual({
    type: 'input',
    event: { kind: 'text', text: 'pasted' },
  })
  expect(memberMessageOf({ type: 'go_to', url: 'javascript:alert(1)' })).toBeUndefined()
  expect(memberMessageOf({ type: 'go_to', url: 'https://example.com/a' })).toEqual({
    type: 'go_to',
    url: 'https://example.com/a',
  })
  expect(memberMessageOf({ type: 'go', direction: 'forward' })).toEqual({ type: 'go', direction: 'forward' })
  expect(memberMessageOf({ type: 'resize', width: 800, height: '600' })).toEqual({
    type: 'resize',
    width: 800,
    height: 0,
  })
  expect(memberMessageOf({ type: 'frame_ack', sessionId: 4 })).toEqual({ type: 'frame_ack' })
  expect(
    memberMessageOf({ type: 'files', files: [{ name: 'a.txt', mimeType: 'text/plain', data: 'aGk=', path: '/etc' }] }),
  ).toEqual({ type: 'files', files: [{ name: 'a.txt', mimeType: 'text/plain', data: 'aGk=' }] })
  expect(memberMessageOf({ type: 'files', files: [{ data: 'aGk=' }] })).toBeUndefined()
  const half = 'A'.repeat(6 * 1024 * 1024)
  expect(
    memberMessageOf({
      type: 'files',
      files: [
        { name: 'a', data: half },
        { name: 'b', data: half },
      ],
    }),
  ).toBeUndefined()
})

test('a visited address is recorded without its query or fragment, and only for web pages', () => {
  expect(visitedAddressOf('https://shop.example.com/cart?token=secret#pay')).toBe('https://shop.example.com/cart')
  expect(visitedAddressOf('about:blank')).toBeUndefined()
  expect(visitedAddressOf('not a url')).toBeUndefined()
})

test("the browser's answer is its text, with an image when it took one", () => {
  expect(browserAnswerOf('Clicked e5')).toEqual({ text: 'Clicked e5' })
  expect(browserAnswerOf({ text: 'Screenshot', image: 'abc' })).toEqual({ text: 'Screenshot', image: 'abc' })
  expect(browserAnswerOf(undefined)).toEqual({ text: '' })
})

test("a host's refusal to start a browser reads in the member's terms", () => {
  expect(browserStartFailureOf('refused: no room for another browser on this host')).toBe(
    "The runtime's host has no room for another browser right now",
  )
  expect(browserStartFailureOf('refused: runtime is not running')).toBe(browserAsleepRefusal)
  expect(browserStartFailureOf('Runtime host x did not answer in time')).toBe('The browser could not start')
})

test('a download the browser reports names its file by id, with a name and a size, or it is ignored', () => {
  const file = 'a'.repeat(32)
  expect(browserDownloadOf({ type: 'download', file, name: 'video.mp4', size: 3_000_000_000 })).toEqual({
    file,
    name: 'video.mp4',
    size: 3_000_000_000,
  })
  for (const message of [
    { file: '../profile/Cookies', name: 'x', size: 1 },
    { file, name: '', size: 1 },
    { file, name: 'x'.repeat(256), size: 1 },
    { file, name: 'x', size: -1 },
    { file, name: 'x', size: '1' },
  ])
    expect(browserDownloadOf(message)).toBeUndefined()
})

test('a screenshot answer names its image file by id', () => {
  expect(imageFileOf({ text: 'Screenshot', imageFile: 'b'.repeat(32) })).toBe('b'.repeat(32))
  expect(imageFileOf({ text: 'Screenshot', imageFile: '../x' })).toBeUndefined()
  expect(imageFileOf('Clicked')).toBeUndefined()
})

test('a downloaded file keeps its name in the save dialog, any character included, without breaking the header', () => {
  expect(contentDispositionOf('report.pdf')).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`)
  expect(contentDispositionOf('été "final".mp4')).toBe(
    `attachment; filename="_t_ _final_.mp4"; filename*=UTF-8''%C3%A9t%C3%A9%20%22final%22.mp4`,
  )
  expect(contentDispositionOf('a\r\nSet-Cookie: x')).not.toContain('\n')
  expect(contentDispositionOf("it's (final)*.zip")).toBe(
    `attachment; filename="it's (final)*.zip"; filename*=UTF-8''it%27s%20%28final%29%2A.zip`,
  )
})
