import type { Database } from '@spyria/db/postgres'
import { log } from '@spyria/kernel'

export const sessionsEndedChannel = 'sessions_ended'

export type WatchedSession = { workspaceId: string; sessionId: string; end: () => void }

const keyOf = ({ workspaceId, sessionId }: { workspaceId: string; sessionId: string }) => `${workspaceId}/${sessionId}`

const watchSessionEndingsIn = (database: Database) => {
  const watched = new Set<WatchedSession>()
  let isCheckDue = false
  let checking: Promise<void> | undefined
  let hasLoggedListenFailure = false
  let listening: Promise<{ unlisten: () => Promise<void> } | undefined> | undefined
  const endEndedSessions = async () => {
    const sessions = [...watched]
    if (sessions.length === 0) return
    const liveKeys = new Set(
      (
        await database.$client<{ workspaceId: string; sessionId: string }[]>`
          select workspace_id as "workspaceId", id as "sessionId" from sessions
          where id = any(${database.$client.array(sessions.map(({ sessionId }) => sessionId))}::text[])`
      ).map(keyOf),
    )
    for (const session of sessions) if (!liveKeys.has(keyOf(session)) && watched.delete(session)) session.end()
  }
  const check = () => {
    isCheckDue = true
    checking ??= (async () => {
      while (isCheckDue) {
        isCheckDue = false
        await endEndedSessions().catch((error: unknown) =>
          log.warn({ event: 'session.ending_check_failed', body: 'Ended sessions could not be checked', error }),
        )
      }
      checking = undefined
    })()
  }
  const listen = () => {
    listening ??= database.$client.listen(sessionsEndedChannel, check, check).then(
      (listener) => {
        hasLoggedListenFailure = false
        return listener
      },
      (error: unknown) => {
        if (!hasLoggedListenFailure)
          log.warn({
            event: 'session.listen_failed',
            body: 'Streams of ended sessions close only when their token expires',
            error,
          })
        hasLoggedListenFailure = true
        listening = undefined
        return undefined
      },
    )
  }
  return {
    watch: (session: WatchedSession) => {
      watched.add(session)
      listen()
      check()
      return () => {
        watched.delete(session)
      }
    },
    release: async () => {
      watched.clear()
      await (await listening)?.unlisten()
    },
  }
}

const sessionEndingsByDatabase = new Map<Database, ReturnType<typeof watchSessionEndingsIn>>()

export const sessionEndingsOf = (database: Database) => {
  const sessionEndings = sessionEndingsByDatabase.get(database) ?? watchSessionEndingsIn(database)
  sessionEndingsByDatabase.set(database, sessionEndings)
  return sessionEndings
}

export const releaseSessionEndings = async (database: Database) => {
  const sessionEndings = sessionEndingsByDatabase.get(database)
  sessionEndingsByDatabase.delete(database)
  await sessionEndings?.release()
}
