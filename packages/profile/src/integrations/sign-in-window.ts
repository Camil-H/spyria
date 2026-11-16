import { SignInReplaced, SignInWindowBlocked, SignInWindowClosed } from '../domain/errors.ts'

const windowFeatures = 'popup,width=520,height=720'
const defaultClosedGraceMilliseconds = 1_500
const keepWaiting = () => {}
let replaceWaitingSignIn = keepWaiting

export const signInThroughWindow = async <Started extends { authorizeUrl: string }>(
  channelName: string,
  startSignIn: () => Promise<Started>,
  { closedGraceMilliseconds = defaultClosedGraceMilliseconds } = {},
) => {
  replaceWaitingSignIn()
  const signInWindow = open('about:blank', channelName, windowFeatures)
  if (!signInWindow) throw new SignInWindowBlocked()
  const channel = new BroadcastChannel(channelName)
  const finished = Promise.withResolvers<void>()
  channel.addEventListener('message', () => finished.resolve(), { once: true })
  let closedTimer: ReturnType<typeof setTimeout> | undefined
  const endIfClosed = () => {
    if (signInWindow.closed && closedTimer === undefined)
      closedTimer = setTimeout(() => finished.reject(new SignInWindowClosed()), closedGraceMilliseconds)
  }
  const replace = () => finished.reject(new SignInReplaced())
  replaceWaitingSignIn = replace
  addEventListener('focus', endIfClosed)
  try {
    const started = await startSignIn()
    signInWindow.location.href = started.authorizeUrl
    await finished.promise
    return started
  } catch (error) {
    if (!(error instanceof SignInReplaced)) signInWindow.close()
    throw error
  } finally {
    clearTimeout(closedTimer)
    removeEventListener('focus', endIfClosed)
    channel.close()
    if (replaceWaitingSignIn === replace) replaceWaitingSignIn = keepWaiting
  }
}
