const hostImage = 'hq-host'

export const hostCommandOf = ({ origin, code, rootless }: { origin: string; code: string; rootless: boolean }) =>
  [
    'docker run -d --name hq-host --restart unless-stopped',
    rootless ? '--user 0' : '--group-add $(stat -c %g /var/run/docker.sock)',
    '--cap-drop ALL --security-opt no-new-privileges --read-only',
    `-v ${rootless ? '$XDG_RUNTIME_DIR/docker.sock' : '/var/run/docker.sock'}:/var/run/docker.sock`,
    '-v hq-host:/state',
    hostImage,
    `${origin}/h/${code}`,
  ].join(' ')
