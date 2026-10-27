# 0022. No screenshot baselines; reviewers judge the looks

## Context

The visual suite compared pixels against 28 baselines in light and dark. Baselines are specific to the platform that renders them, so the macOS baselines fail on Linux CI, and keeping Linux ones means a special container to update them. An updated baseline is easy to accept without looking, so a pixel diff mostly asks for approval rather than judgement.

## Decision

- There are no `toHaveScreenshot` assertions and no baselines.
- The layout, keyboard, resize and colour rules a user relies on stay as ordinary e2e assertions (bounding boxes, computed colours, focus) in the segment of their area.
- A pull request that changes the UI includes screenshots in light and dark, and the reviewer judges the looks from them.

## Consequences

- CI needs no platform-specific files and no special container; the former visual tests run with the e2e suite and its test selection.
- A visual regression nobody asserted, for example on a page the change did not mean to touch, is caught only by a reviewer or a user.
