import { afterEach, expect, test } from 'bun:test'
import { SignInReplaced, SignInWindowBlocked, SignInWindowClosed } from '../domain/errors.ts'
import { signInThroughWindow } from './sign-in-window.ts'

const channelName = 'spyria-sign-in-window-test'
const authorizeUrl = 'https://provider.test/authorize'
const realOpen = globalThis.open
afterEach(() => {
  globalThis.open = realOpen
})

const fakeWindow = () => {
  const signInWindow = { closed: false, location: { href: 'about:blank' }, close: () => {} }
  signInWindow.close = () => {
    signInWindow.closed = true
  }
  return signInWindow
}
const opening = (signInWindow: ReturnType<typeof fakeWindow> | null) => {
  const opened: string[] = []
  globalThis.open = ((url: string) => {
    opened.push(url)
    return signInWindow
  }) as typeof open
  return opened
}
const finishSignIn = () => {
  const callbackPage = new BroadcastChannel(channelName)
  callbackPage.postMessage({ connected: true })
  callbackPage.close()
}
const rejectionOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('The promise was expected to reject')
}
const settled = () => new Promise((resolve) => setTimeout(resolve, 20))

test('a blocked sign-in window is refused with what to do, and the app never leaves its page', async () => {
  opening(null)
  let isStarted = false
  const refusal = await rejectionOf(
    signInThroughWindow(channelName, async () => {
      isStarted = true
      return { authorizeUrl }
    }),
  )
  expect(refusal).toBeInstanceOf(SignInWindowBlocked)
  expect(refusal.message).toBe('Your browser blocked the sign-in window. Allow pop-ups for Spyria, then try again.')
  expect(isStarted).toBe(false)
})

test('the window goes to the provider and the sign-in ends once its callback page says so', async () => {
  const signInWindow = fakeWindow()
  expect(opening(signInWindow)).toEqual([])
  const signingIn = signInThroughWindow(channelName, async () => ({ authorizeUrl, connectionId: 'c1' }))
  await settled()
  expect(signInWindow.location.href).toBe(authorizeUrl)
  finishSignIn()
  expect(await signingIn).toEqual({ authorizeUrl, connectionId: 'c1' })
})

test('a window closed before the sign-in finished ends the wait once the member is back, after the callback had time to speak', async () => {
  const signInWindow = fakeWindow()
  opening(signInWindow)
  const stillOpen = signInThroughWindow(channelName, async () => ({ authorizeUrl }), { closedGraceMilliseconds: 10 })
  await settled()
  dispatchEvent(new Event('focus'))
  await settled()
  finishSignIn()
  expect(await stillOpen).toEqual({ authorizeUrl })

  const closing = signInThroughWindow(channelName, async () => ({ authorizeUrl }), { closedGraceMilliseconds: 10 })
  await settled()
  signInWindow.closed = true
  dispatchEvent(new Event('focus'))
  const refusal = await rejectionOf(closing)
  expect(refusal).toBeInstanceOf(SignInWindowClosed)
  expect(refusal.message).toBe('The sign-in window was closed before the sign-in finished. Try again.')
})

test('a callback that speaks as the window closes still counts as finished', async () => {
  const signInWindow = fakeWindow()
  opening(signInWindow)
  const signingIn = signInThroughWindow(channelName, async () => ({ authorizeUrl }), { closedGraceMilliseconds: 50 })
  await settled()
  signInWindow.closed = true
  dispatchEvent(new Event('focus'))
  finishSignIn()
  expect(await signingIn).toEqual({ authorizeUrl })
})

test('a sign-in started again replaces the one waiting, without closing the window both share', async () => {
  const signInWindow = fakeWindow()
  opening(signInWindow)
  const first = signInThroughWindow(channelName, async () => ({ authorizeUrl: `${authorizeUrl}?first` }))
  await settled()
  const second = signInThroughWindow(channelName, async () => ({ authorizeUrl: `${authorizeUrl}?second` }))
  expect(await rejectionOf(first)).toBeInstanceOf(SignInReplaced)
  expect(signInWindow.closed).toBe(false)
  await settled()
  expect(signInWindow.location.href).toBe(`${authorizeUrl}?second`)
  finishSignIn()
  expect(await second).toEqual({ authorizeUrl: `${authorizeUrl}?second` })
})

test('a sign-in the server refuses closes its window and passes the refusal on', async () => {
  const signInWindow = fakeWindow()
  opening(signInWindow)
  const refusal = new Error('refused')
  expect(
    await rejectionOf(
      signInThroughWindow(channelName, async () => {
        throw refusal
      }),
    ),
  ).toBe(refusal)
  expect(signInWindow.closed).toBe(true)
})
