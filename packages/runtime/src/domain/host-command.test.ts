import { expect, test } from 'bun:test'
import { hostCommandOf } from './host-command.ts'

test('the host command replaces spyria-host and its state, picks rootless or rooted Docker itself and rewrites localhost', () => {
  const workspaceCommand = hostCommandOf({ origin: 'https://spyria.test', code: 'ABCDEFGH' })
  expect(workspaceCommand).toStartWith(
    'docker rm -f hq-host >/dev/null 2>&1; docker volume rm hq-host >/dev/null 2>&1; docker run -d --name hq-host ',
  )
  expect(workspaceCommand).toContain("docker info -f '{{.SecurityOptions}}' | grep -q rootless")
  expect(workspaceCommand).toContain('--user 0 -v $XDG_RUNTIME_DIR/docker.sock:/var/run/docker.sock')
  expect(workspaceCommand).toContain('--group-add $(')
  expect(workspaceCommand).toContain('-v /var/run/docker.sock:/var/run/docker.sock')
  expect(workspaceCommand).not.toContain('--add-host')
  expect(workspaceCommand).toEndWith(' spyria-host https://spyria.test/h/ABCDEFGH')

  const localCommand = hostCommandOf({ origin: 'http://localhost:5173', code: 'ABCDEFGH', personal: true })
  expect(localCommand).toStartWith('docker build -q -t spyria-host apps/host >/dev/null && docker rm -f hq-host ')
  expect(localCommand).toContain(' --add-host host.docker.internal:host-gateway ')
  expect(localCommand).toEndWith(' spyria-host --personal http://host.docker.internal:5173/h/ABCDEFGH')
})

test('the personal host command signs in to the chosen tool once the host runs', () => {
  for (const tool of ['claude', 'codex'] as const)
    expect(hostCommandOf({ origin: 'https://spyria.test', code: 'ABCDEFGH', personal: true, signIn: tool })).toEndWith(
      ` spyria-host --personal https://spyria.test/h/ABCDEFGH && docker exec -it hq-host spyria-host login ${tool}`,
    )
})
