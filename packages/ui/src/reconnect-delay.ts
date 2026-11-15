const firstReconnectMilliseconds = 1000
const longestReconnectMilliseconds = 30_000
const jitterShare = 0.2

export const reconnectDelayOf = (failedAttempts: number, random: () => number = Math.random) => {
  const backedOff = Math.min(longestReconnectMilliseconds, firstReconnectMilliseconds * 2 ** failedAttempts)
  const jittered = backedOff * (1 - jitterShare + 2 * jitterShare * random())
  return Math.round(Math.min(longestReconnectMilliseconds, jittered))
}
