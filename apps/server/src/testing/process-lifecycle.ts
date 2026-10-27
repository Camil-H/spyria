import { spawnSync } from 'node:child_process'
import { log } from '@spyria/kernel'

const maximumAncestors = 12
const exitCodeBySignal = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const

const ancestryOf = (processId: number) => {
  const ancestors: string[] = []
  for (let current = processId; current > 1 && ancestors.length < maximumAncestors; ) {
    const row = String(spawnSync('ps', ['-o', 'pid=,ppid=,pgid=,args=', '-p', String(current)]).stdout ?? '').trim()
    if (row === '') break
    ancestors.push(row.slice(0, 200))
    current = Number(row.split(/\s+/)[1])
  }
  return ancestors.join(' <- ')
}

const processAttributes = () => ({
  'process.pid': process.pid,
  'process.parent_pid': process.ppid,
  'process.ancestry': ancestryOf(process.pid),
})

export const serveWithLifecycleLogs = (name: string, port: number, serve: () => { port?: number }) => {
  process.on('unhandledRejection', (error) =>
    log.error({ event: `${name}.unhandled_rejection`, body: 'A promise rejected with nobody awaiting it', error }),
  )
  process.on('uncaughtException', (error) =>
    log.error({ event: `${name}.uncaught_exception`, body: 'An exception reached the event loop', error }),
  )
  process.on('exit', (code) =>
    log.error({
      event: `${name}.exit`,
      body: 'The test server process is exiting',
      attributes: { 'process.exit_code': code, 'process.parent_pid': process.ppid },
    }),
  )
  for (const [signal, exitCode] of Object.entries(exitCodeBySignal))
    process.on(signal, () => {
      log.error({
        event: `${name}.signal`,
        body: `The test server received ${signal}`,
        attributes: { 'process.signal': signal, ...processAttributes() },
      })
      process.exit(exitCode)
    })
  try {
    const server = serve()
    log.info({
      event: `${name}.started`,
      body: 'The test server is listening',
      attributes: { 'server.port': server.port, ...processAttributes() },
    })
    return server
  } catch (error) {
    log.error({
      event: `${name}.listen_failed`,
      body: 'The test server could not listen on its port',
      attributes: { 'server.port': port, ...processAttributes() },
      error,
    })
    process.exit(1)
  }
}
