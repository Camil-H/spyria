import { expect, test } from 'bun:test'
import { defaultDeployment, harnessIds } from '@spyria/kernel'
import { hostCommandOf } from './host-command.ts'

test("the host command replaces spyria-host and its state, picks rootless or rooted Docker itself, passes on the shell's proxy settings and rewrites localhost", () => {
  const workspaceCommand = hostCommandOf({
    deployment: defaultDeployment,
    origin: 'https://spyria.test',
    code: 'ABCDEFGH',
  })
  expect(workspaceCommand).toStartWith(
    'docker rm -f spyria-host >/dev/null 2>&1; docker volume rm spyria-host >/dev/null 2>&1; docker run -d --name spyria-host ',
  )
  expect(workspaceCommand).toContain("docker info -f '{{.SecurityOptions}}' | grep -q rootless")
  expect(workspaceCommand).toContain('--user 0 -v $XDG_RUNTIME_DIR/docker.sock:/var/run/docker.sock')
  expect(workspaceCommand).toContain('--group-add $(')
  expect(workspaceCommand).toContain('-v /var/run/docker.sock:/var/run/docker.sock')
  expect(workspaceCommand).not.toContain('--add-host')
  expect(workspaceCommand).toContain(' --restart unless-stopped -e HTTPS_PROXY -e HTTP_PROXY -e NO_PROXY ')
  expect(workspaceCommand).toEndWith(' spyria-host https://spyria.test/h/ABCDEFGH')

  const localCommand = hostCommandOf({
    deployment: defaultDeployment,
    origin: 'http://localhost:5173',
    code: 'ABCDEFGH',
    personal: true,
  })
  expect(localCommand).toStartWith('docker build -q -t spyria-host apps/host >/dev/null && docker rm -f spyria-host ')
  expect(localCommand).toContain(' --add-host host.docker.internal:host-gateway ')
  expect(localCommand).toEndWith(' spyria-host --personal http://host.docker.internal:5173/h/ABCDEFGH')
})

test('the personal host command signs in to the chosen tool once the host runs', () => {
  for (const tool of harnessIds)
    expect(
      hostCommandOf({
        deployment: defaultDeployment,
        origin: 'https://spyria.test',
        code: 'ABCDEFGH',
        personal: true,
        signIn: tool,
      }),
    ).toEndWith(
      ` spyria-host --personal https://spyria.test/h/ABCDEFGH && docker exec -it spyria-host spyria-host login ${tool}`,
    )
})

test("another deployment's command names its own host container, state volume and image, and tells the host its deployment", () => {
  const command = hostCommandOf({
    deployment: 'spyria-prod',
    origin: 'https://spyria.test',
    code: 'ABCDEFGH',
    personal: true,
    signIn: 'codex',
  })
  expect(command).toStartWith(
    'docker rm -f spyria-prod-host >/dev/null 2>&1; docker volume rm spyria-prod-host >/dev/null 2>&1; docker run -d --name spyria-prod-host --restart unless-stopped -e SPYRIA_DEPLOYMENT=spyria-prod ',
  )
  expect(command).toContain(' -v spyria-prod-host:/state spyria-prod-host --personal https://spyria.test/h/ABCDEFGH ')
  expect(command).toEndWith(' && docker exec -it spyria-prod-host spyria-host login codex')
  expect(hostCommandOf({ deployment: 'spyria-prod', origin: 'http://localhost:5173', code: 'ABCDEFGH' })).toStartWith(
    'docker build -q -t spyria-prod-host apps/host >/dev/null && ',
  )
  expect(
    hostCommandOf({ deployment: defaultDeployment, origin: 'https://spyria.test', code: 'ABCDEFGH' }),
  ).not.toContain('SPYRIA_DEPLOYMENT')
})
