# 0040. The streamed browser is the agent's browser, not a browser to watch videos in

Amends [decision 0037](0037-a-browser-per-member-next-to-the-runtime.md).

## Context

[Decision 0037](0037-a-browser-per-member-next-to-the-runtime.md) gave each member a real Chromium next to the runtime, streamed to the Browser tab as images. Used as an everyday browser, it falls short: it streams no sound, video stutters at the frame rate an image stream allows, and each browser costs 300 to 500 MB on the host. Matching a local browser would take audio streaming, a video codec and much more host capacity, for something every member already has on their own computer. The files the agent writes, such as HTML reports, never needed it: they render in the app, in an isolated frame, sharp and at once.

## Decision

- The streamed browser serves the agent: it browses for the member who prompted, previews the app the agent runs in the runtime (`localhost`), and lets the member step in for a sign-in, a captcha or a check, then hand back.
- It streams no sound and is not tuned for video. When a web page is shown, the tab says so and offers to open the page in a new tab of the member's own browser.
- Files of the project the agent opens keep rendering in the app's isolated frame and never start a Chromium.
- The stream follows the member's screen density, up to twice its pixels and at most 3,200 pixels across, so text stays sharp on high-density screens.
- A browser that failed to start can be started again from the tab, and the host makes a browser again from its runtime's image when an older image made it, keeping its sign-ins.

## Consequences

- No work on audio or video streaming; the cost of a browser stays what decision 0037 set.
- On a high-density screen, a frame carries up to four times the pixels it did, within the stream's existing limits.
- A deployment that updates its runtime image no longer keeps browsers made from the previous image.
