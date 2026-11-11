import { databaseUrlOf } from '@spyria/db/testing'

const operatorCli = new URL('../operator-cli.ts', import.meta.url).pathname

export const runOperator = async (databaseName: string, args: string[], environment: Record<string, string> = {}) => {
  const operator = Bun.spawn([process.execPath, operatorCli, ...args], {
    stderr: 'pipe',
    env: { ...process.env, DATABASE_URL: databaseUrlOf(databaseName), ...environment },
  })
  return {
    exitCode: await operator.exited,
    stdout: await new Response(operator.stdout).text(),
    stderr: await new Response(operator.stderr).text(),
  }
}
