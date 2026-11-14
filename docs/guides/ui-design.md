# UI design guidelines

Every screen of the web app draws from one set of design tokens and one set of shared components, so that a page built today looks like a page built a year ago. This guide lists them and says which one to use where. The tokens live in [`apps/web/src/app/styles.css`](../../apps/web/src/app/styles.css); the shared component classes and components in [`packages/ui`](../../packages/ui/src/index.ts).

The theme defines the only utilities that exist: Tailwind's default colours, font sizes and font weights are removed, so `text-lg`, `font-bold` or `bg-red-500` produce no style. The unit test [`design-tokens.test.ts`](../../packages/ui/src/design-tokens.test.ts) fails on any of them, on arbitrary values (`text-[13px]`, `text-[#fff]`, `tracking-[0.3em]`) and on palette colours used directly, with the file and line. When a design needs something the tokens cannot express, add a token here and in the theme, not a one-off value in a component.

## Typography

One typeface: **Outfit**, a variable font served with the app (`@fontsource-variable/outfit`), never loaded from a third party. `font-sans` is Outfit; `font-mono` (code, commit hashes, paths, command output) is the system monospace stack. Keyboard keys (`kbd`) use `font-sans`.

The body text is 14 px (`text-sm`): text without a size class is body text.

| Role | Class | Size / line height | Weight | Used for |
|---|---|---|---|---|
| Page title | `text-title` | 24 / 32 | semibold | The one `h1` of a page: Profile, Workspace settings, a chat's title, a sign-in card; a headline figure (the spend total) |
| Heading | `text-heading` | 18 / 28 | semibold | Section titles (`LabelledSection`'s default), full-screen messages (no chat selected, signed out, no access), the profile name |
| Subheading | `text-subheading` | 16 / 24 | medium | Dialog titles |
| Subsection | `text-sm font-medium` | 14 / 20 | medium | `h3` and `h4` titling a block inside a section, side panel titles, form group titles |
| Group title | `text-xs font-medium text-muted` | 12 / 16 | medium | A small title above a group of rows: a commit in the changes list, the parts of a chart |
| Body | `text-sm` | 14 / 20 | normal | Paragraphs, rows, fields, menus, buttons, Markdown |
| Caption | `text-xs` | 12 / 16 | normal | Metadata, timestamps, counts, hints, small buttons, tooltips, table column headers (`rowHeaderClass`) |
| Overline | `overlineClass` | 12 / 16, tracked, uppercase | medium | Group labels above a list: sidebar groups, tool groups, the Spyria wordmark |
| Chart label | `text-chart-label` | 11, in chart units | normal | Axis and value labels inside an SVG chart, sized to its `viewBox` |

The headings carry their weight: write `text-heading`, not `text-heading font-semibold`. Three weights exist:

- `font-normal` (400) for text.
- `font-medium` (500) for what you act on or name: buttons, the selected tab or choice, labels, subsection titles, the workspace name.
- `font-semibold` (600) for headings (through their token) and for emphasis that must read as bold: a member's name in a sentence, a total row. `<strong>` and Markdown bold are semibold.

## Colour

Components use semantic colours only. A token that differs between themes resolves to its light and dark value with `light-dark()` (the accent is the same in both), so a component needs no `dark:` variant for colour. The raw palette (`--palette-*`) exists only to define the tokens.

| Group | Tokens | Use |
|---|---|---|
| Surfaces | `app`, `sidebar`, `raised`, `hover`, `selected` | Page background, the sidebar, cards, menus and dialogs above the page, hover and selected rows |
| Text | `ink`, `muted`, `link` | Main text, secondary text, links |
| Lines | `line`, `focus` | Borders and dividers; the focus outline (through `focusRing`) |
| Accent | `accent`, `accent-hover`, `accent-ink` | The primary button and selected markers; `accent-ink` is the text on `accent` |
| Callout | `callout`, `callout-hover`, `callout-edge` | A notice that needs attention (`calloutClass`) |
| Status | `success`, `warning`, `danger`, `info` | Done, waiting or attention, failed or over budget, working; status dots, icons, bars |
| Diff | `added`, `removed` | Added and removed lines; `removed` is also the danger button's background |
| Chart | `chart-1` to `chart-6`, `chart-other` | Chart series in order, then everything grouped as "other"; a single series uses `chart-1` |
| Code | `code-keyword`, `code-string`, `code-number`, `code-title`, `code-built-in` | Syntax highlighting |
| Brand scenery | `spire-*`, `card-edge`, `card-glow` | The sign-in and empty-state backgrounds only |
| Fixed | `white`, `black` | Scrims (`backdrop:bg-black/40`), text on an image, a web page's own white background, the hairline ring of a toast |

Colour never carries meaning alone: a status dot sits next to its word (`StatusBadge`), an icon has an accessible name.

## Components

Reuse before styling. The classes in [`classes.ts`](../../packages/ui/src/classes.ts) and the components of `@spyria/ui` are the vocabulary; a new look starts there, not in a feature package.

| Need | Use |
|---|---|
| The main action of a form or dialog | `buttonClass` (accent, pill), `smallButtonClass` in tight rows |
| A secondary action | `ghostButtonClass`, `smallGhostButtonClass` (also for pill actions inside a message or step: Stop, Connect) |
| A destructive confirmation | `dangerButtonClass` |
| An action inside a sentence or a status line (Retry, Wake, a checklist task) | `inlineActionClass` |
| An icon-only action | `IconButton` / `iconButtonClass`, always with a label and a tooltip |
| Inputs and selects | `fieldClass` inside a `labelClass` label |
| Tabs | `tabTriggerClass` |
| A choice between two to four options | `SegmentedChoice` |
| An on/off setting | `Switch` inside a `SettingRow` |
| Menus | `RowMenu`, or `menuContentClass` and `menuItemClass` |
| Lists of items | `rowListClass` with `rowClass` rows and a `rowHeaderClass` header |
| A grouped block | `cardClass` |
| A titled section | `LabelledSection` |
| Dialogs, toasts, tooltips | `Dialog`, `Toast`, `tooltipClass` |
| Status | `StatusBadge`, `Spinner`, `ErrorMessage` |
| Keyboard shortcuts | `ShortcutKeys` |

Every element you can tab to shows keyboard focus with `focusRing`, which the button, field, tab and icon button classes include; menu items show it with the `hover` background. A disabled button or field has reduced opacity and `cursor-not-allowed`.

## Shape, elevation, spacing, icons

- **Radius:** `rounded-md` for fields, menu items and icon buttons; `rounded-full` for buttons, pills, avatars and dots; `rounded-lg` for cards, menus and segmented choices; `rounded-xl` for dialogs, toasts and the composer; `rounded-2xl` for the sign-in and empty-state cards.
- **Elevation:** surfaces sit on `raised` with a `line` border. Shadows mark what floats: `shadow-md` for a floating button, `shadow-lg` for menus and tooltips, `shadow-xl` for toasts and the sign-in cards, `shadow-2xl` for dialogs.
- **Spacing:** Tailwind's 4 px scale. `gap-1` to `gap-3` inside a component, `gap-4` to `gap-6` between the blocks of a page, `px-4 py-3` in rows and callouts.
- **Icons:** [Lucide](https://lucide.dev) only, `size-4` next to body text, `size-3.5` next to captions, 18 px inside an `IconButton` (16 px when small), `aria-hidden` when a word says the same thing.

## Words

Plain language in the user's terms, no internal names ([AGENTS.md](../../AGENTS.md)). Sentence case everywhere: titles, buttons, tabs, menu items. A button says what it does ("Add key", "Remove member"), and an empty list says what will appear there and how to add the first item.

## Checking a UI change

- `bun run test` runs the token check; `bun run lint` and `bun run typecheck` the rest.
- A UI pull request includes light and dark screenshots ([decision 0022](../decisions/0022-no-screenshot-baselines.md)); the reviewer compares them with this guide.
- Colours, weights and sizes a user relies on (a status colour, a bold total) are e2e assertions; compare against a token (`var(--color-success)`), never a raw value.
