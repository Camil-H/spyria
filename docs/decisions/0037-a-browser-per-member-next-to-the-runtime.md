# 0037. Each member gets a real browser of their own, next to the chat's runtime

## Context

The Browser tab showed web pages read by the server, framed without their scripts, and pages on the member's own machine framed directly. Most of the web needs its scripts, many sites refuse to be framed, a framed sign-in differs from a real one, sites detect a frame (`Sec-Fetch-Dest: iframe`, `window.top`), and the agent could not act on any page: it only opened addresses for members to load. `take_screenshot` ran a throwaway Chromium inside the runtime, with nothing kept between calls.

## Decision

- **One browser per member per chat**, a full Chromium in its own container next to the chat's runtime, never inside it. It runs visible on a virtual display, without the automation flag and with a real user agent, and is streamed to the **Browser** tab, where the member's clicks, keys, paste, uploads and downloads go back to it. The page never runs inside Spyria's own page, so sites that refuse framing work. No stealth or fingerprint spoofing: on a captcha or a "browser not secure" block, the member solves it in the stream and hands back.
- **Only its member reaches it.** The agent's shell cannot read its profile, cookies or processes: the container shares only the runtime's network (`container:<runtime>`), so `localhost` reaches the dev server the agent started. Chromium listens on no port: Playwright drives it through its pipe, and a controller in the container speaks to the host over the container's standard input and output (Docker attach), which only the host reaches. The virtual display listens on no network or abstract socket, since the runtime shares the network namespace. The runtime's agent keeps requiring its API key, since a page's scripts can reach the runtime's ports.
- **The agent drives a browser only through Spyria's tool server**: `open_page` and `browser_snapshot`, `browser_click`, `browser_type`, `browser_fill`, `browser_press`, `browser_run_javascript`, `browser_wait`, `browser_navigate` and `browser_screenshot`. The server sends each call to the browser of the member who prompted the turn, through that runtime's host connection; on Bob's prompt, Alice's browser cannot be reached. The host knows a browser only by a hash of the workspace, runtime and member.
- **Only its member watches the stream.** Others see the agent's steps and screenshots. What the agent reads in a member's browser can land in the shared chat, so the tab warns the member the first time.
- **Admins set the browser per workspace**: on or off for agents and for members separately; internal networks blocked by default (the host machine mapping first), with named internal addresses allowed, such as staging; sites allowed and blocked; how long sign-ins last; downloads and uploads; the member's approval before the agent submits a form or runs a script in their browser (reading needs none); and visited addresses recorded per chat in the audit log, without query, fragment or page contents. Sites and networks are enforced by a proxy in the browser's container that checks every address a name resolves to and connects to the one it checked.
- **A browser lives as long as the chat's runtime**: it is removed with its sign-ins when the runtime stops, and stops on its own after 10 minutes without use, much sooner than a runtime, since each Chromium takes 300 to 500 MB. A host with less than 768 MB free refuses a new one.
- **Files leave the browser as files**: a download or a screenshot is saved in the browser's volume, the stream only says it is ready, and the server reads it through the host at its own pace, so the stream stays small whatever a page downloads.
- **On a member's own machine** the browser container runs there too, so their sign-ins stay on their computer.
- **The script-free reader is removed**, with no fallback: a channel has no runtime and so no Browser tab, and a browser the host has no room for says so.

## Consequences

- Pages work as in the member's own browser, with their sign-ins, and the agent can read and act on them, including the app it runs in the runtime.
- Each watching member costs a Chromium on the runtime's host; the idle stop and the free-memory check bound it.
- The runtime image carries Chromium and a virtual display, used by both `take_screenshot` and the browser container, from the same image digest.
- Hosts need protocol 5.
- Possible later: a Spyria extension driving the member's own Chrome tabs, as a per-member option (real tabs and sign-ins, no host memory, but an install, Chrome open, and the agent in their everyday sign-ins); sign-ins kept across chats, only on a member's own machine.
