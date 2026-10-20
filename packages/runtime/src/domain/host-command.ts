import { type HarnessId, signInCommandOf } from '@spyria/kernel'

const hostImage = 'spyria-host'
const dockerSocket = '/var/run/docker.sock'
const rootlessFlags = `--user 0 -v $XDG_RUNTIME_DIR/docker.sock:${dockerSocket}`
const rootedFlags = `--group-add $(test "$(uname)" = Darwin && echo 0 || stat -c %g ${dockerSocket}) -v ${dockerSocket}:${dockerSocket}`
const dockerFlags = `$(docker info -f '{{.SecurityOptions}}' | grep -q rootless && echo "${rootlessFlags}" || echo "${rootedFlags}")`
const hostGateway = 'host.docker.internal'

export const hostCommandOf = ({
  origin,
  code,
  personal = false,
  signIn,
}: {
  origin: string
  code: string
  personal?: boolean
  signIn?: HarnessId
}) => {
  const url = new URL(origin)
  const isLocalhost = url.hostname === 'localhost'
  if (isLocalhost) url.hostname = hostGateway
  return [
    ...(isLocalhost ? [`docker build -q -t ${hostImage} apps/host >/dev/null &&`] : []),
    'docker rm -f spyria-host >/dev/null 2>&1; docker volume rm spyria-host >/dev/null 2>&1;',
    'docker run -d --name spyria-host --restart unless-stopped',
    dockerFlags,
    ...(isLocalhost ? [`--add-host ${hostGateway}:host-gateway`] : []),
    '--cap-drop ALL --security-opt no-new-privileges --read-only',
    '-v spyria-host:/state',
    hostImage,
    ...(personal ? ['--personal'] : []),
    `${url.origin}/h/${code}`,
    ...(signIn ? [`&& ${signInCommandOf(signIn)}`] : []),
  ].join(' ')
}
