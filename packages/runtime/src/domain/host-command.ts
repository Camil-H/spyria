import { defaultDeployment, type HarnessId, hostContainerOf, signInCommandOf } from '@spyria/kernel'

const dockerSocket = '/var/run/docker.sock'
const rootlessFlags = `--user 0 -v $XDG_RUNTIME_DIR/docker.sock:${dockerSocket}`
const rootedFlags = `--group-add $(test "$(uname)" = Darwin && echo 0 || stat -c %g ${dockerSocket}) -v ${dockerSocket}:${dockerSocket}`
const dockerFlags = `$(docker info -f '{{.SecurityOptions}}' | grep -q rootless && echo "${rootlessFlags}" || echo "${rootedFlags}")`
const hostGateway = 'host.docker.internal'
const proxyFlags = '-e HTTPS_PROXY -e HTTP_PROXY -e NO_PROXY'

export const hostCommandOf = ({
  origin,
  code,
  personal = false,
  signIn,
  deployment,
}: {
  deployment: string
  origin: string
  code: string
  personal?: boolean
  signIn?: HarnessId
}) => {
  const url = new URL(origin)
  const isLocalhost = url.hostname === 'localhost'
  if (isLocalhost) url.hostname = hostGateway
  const host = hostContainerOf(deployment)
  return [
    ...(isLocalhost ? [`docker build -q -t ${host} apps/host >/dev/null &&`] : []),
    `docker rm -f ${host} >/dev/null 2>&1; docker volume rm ${host} >/dev/null 2>&1;`,
    `docker run -d --name ${host} --restart unless-stopped`,
    ...(deployment === defaultDeployment ? [] : [`-e SPYRIA_DEPLOYMENT=${deployment}`]),
    proxyFlags,
    dockerFlags,
    ...(isLocalhost ? [`--add-host ${hostGateway}:host-gateway`] : []),
    '--cap-drop ALL --security-opt no-new-privileges --read-only',
    `-v ${host}:/state`,
    host,
    ...(personal ? ['--personal'] : []),
    `${url.origin}/h/${code}`,
    ...(signIn ? [`&& ${signInCommandOf(signIn, deployment)}`] : []),
  ].join(' ')
}
