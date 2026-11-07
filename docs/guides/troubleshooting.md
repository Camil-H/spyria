# Troubleshooting

Start with `spyria doctor`: it checks Docker, each service and its healthcheck, the server's start check (the list of settings it refuses), the disk and the image versions. `spyria compose logs <service>` shows a service's logs, for example `server`, `zero-cache`, `gateway` or `host`.


| Symptom | Cause and fix |
|---|---|
| The server keeps restarting | The production check failed; read `logs server` for the list. |
| `502` from the proxy | The proxy forwards to `https://`. The server speaks plain HTTP on the Compose network: use `http://server:3000`. |
| The app loads but never syncs | The proxy drops WebSocket upgrades on `/zero/`, or zero-cache is down: `/health` answers `503` naming `zero`, and the server logs `zero.unreachable`. |
| A prompt says the runtime image is missing | The host could not pull it: `docker logs <deployment>-host` has the registry's reason. A host built from a clone (no `SPYRIA_IMAGES`) accepts only a local content ID: run `bun run agent:build` there, or load the same image. |
| The host profile cannot reach Docker | `SPYRIA_DOCKER_GROUP` is not the group of `/var/run/docker.sock` (Linux), or Docker runs rootless. |
| Invites are refused, or invited people are told no workspace invited them | The domain is not verified yet; send and open the link from **Workspace settings > Setup SSO**, or use `sso:verify-domain`. |
| SSO client secrets or GitHub App keys stop working | `SPYRIA_SECRETS_KEY` changed. Restore it; otherwise enter every secret again. |
| Members' API keys stop working | `SPYRIA_GATEWAY_ENCRYPTION_KEY` changed. Restore it; otherwise wipe the gateway's database and have members add their keys again. |
| Runtimes stop starting after many chats | The host ran out of Docker address pools; see [Many runtimes on one host](./self-hosting.md#many-runtimes-on-one-host). |
| `spyria setup` stops at the Cloudflare step | The API token lacks a permission: *Account > Cloudflare Tunnel > Edit*, *Zone > DNS > Edit* and *Zone > Zone > Read*, plus the Access and Email Routing ones for those steps (`spyria --help` lists them). |
| Docker refuses `spyria setup` on Linux | Your user is not in the `docker` group: `sudo usermod -aG docker $(id -un)`, log out and back in. |
| The first workspace's link says the deployment is being set up | The link lacks the setup token, or a workspace already exists: `spyria setup-link` prints it again while none exists. |
| A runtime host shows **Update needed** and stays offline | Its protocol is older than the server's minimum: run the command its badge shows on that machine. |
| On a cloud, the site answers `503` for a while after a restart | zero-cache rebuilds its replica from Postgres at each start; the server itself stays up (`/health/live`). |
| On Azure, the hostname has no HTTPS | Run the `certificate_command` output once the DNS records exist ([cloud](./cloud.md)). |
| On Google Cloud, the certificate stays provisioning | The hostname's `A` record must point at the load balancer's address before Google issues it; this takes up to an hour. |
