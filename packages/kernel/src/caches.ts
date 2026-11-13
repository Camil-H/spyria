export const createBoundedCache = <Key, Value>(capacity: number) => {
  const entries = new Map<Key, Value>()
  return {
    get: (key: Key) => {
      const value = entries.get(key)
      if (value === undefined) return undefined
      entries.delete(key)
      entries.set(key, value)
      return value
    },
    set: (key: Key, value: Value) => {
      entries.delete(key)
      entries.set(key, value)
      for (const oldestKey of entries.keys()) {
        if (entries.size <= capacity) break
        entries.delete(oldestKey)
      }
    },
    delete: (key: Key) => entries.delete(key),
    get size() {
      return entries.size
    },
  }
}

export const createSingleflight = <Result>() => {
  const inFlight = new Map<string, Promise<Result>>()
  return (key: string, work: () => Promise<Result>) => {
    const running = inFlight.get(key)
    if (running) return running
    const started = work().finally(() => inFlight.delete(key))
    inFlight.set(key, started)
    return started
  }
}
