# Dashboard text containment

The 2026-10-15 additive fix is `patches/dashboard/text-containment.css` plus `content-folding.mjs`. It targets native Subagents flow cards, compact tree/list rows and details, plus committed/streaming/pending/steering main-chat bubbles.

## Behavior

- Ordinary text, continuous identifiers, long URLs and file paths wrap within the card, including inline clickable file paths.
- Long content defaults to a bounded preview with an explicit **展开全文 / 收起** button. Chat previews are about 18rem high; native task descriptions about 7.5rem. Short content is shown fully without a redundant button. This deliberate preview does not delete/truncate source text or copy data.
- Expansion is kept during streaming updates on the same rendered node. It is not a cross-refresh/global preference; virtualized rows newly mounted return to the preview default. Controls support keyboard activation and expose `aria-expanded` / `aria-controls`. Their visible labels are CSS-generated with accessible names, not text nodes in the message-copy host, so they are not appended to plain-text/selection copy.
- Flex/grid children can shrink instead of sizing the whole page to their longest word. Compact rows may grow vertically when badges wrap.
- Code keeps indentation and local horizontal scrolling. Wide tables keep columns and scroll within the message, not the whole page.
- No message text, tool execution, model routing, research event, transcript or backend logic changes.

## Why an additive stylesheet?

An installed dashboard can have newer optional frontend plugins than this preserved source snapshot. Rebuilding the old snapshot and overwriting its JavaScript could silently remove those unrelated features. The overlay adds a stylesheet and a small native-DOM folding module, leaving **all existing application JavaScript and assets intact**. The module observes only rendered content sizing and adds independent adjacent controls/attributes; it does not replace message text, wrap React subtrees, fetch data or persist preferences.

`prepare-dashboard.sh` adds it after a normal fresh build. For an existing compatible static dashboard, explicitly back up its index, compressed variants and asset inventory first, then:

```bash
node scripts/apply-dashboard-layout.mjs /absolute/path/to/dashboard/dist --dry-run
node scripts/apply-dashboard-layout.mjs /absolute/path/to/dashboard/dist --apply
```

The command publishes content-hashed CSS and the folding module with matching gzip/Brotli variants, then replaces the index last, preserving existing application scripts. It does not restart a service, reload Pi, touch sessions or clean old assets. A browser refresh loads the stylesheet; already-loaded pages are not forcibly reloaded. Roll back by restoring the backed-up index and its compressed variants. No old JavaScript or CSS asset is removed.

## Verify locally

After preparing the fixed upstream checkout and its dependencies:

```bash
# Expected to reproduce the pre-fix overflow/clipped prose:
node scripts/test-dashboard-layout.mjs .runtime/dashboard-source --expect-overflow
# Must pass geometry, readable-prose and local-scroll checks:
npm run test:dashboard:layout
```

The script uses actual `ChatView`, `NativeSubagents` and the full application stylesheet in a synthetic fixture, at 360, 768 and 1440 px. Geometry runs with the application's existing reduced-motion mode to avoid transient decorative-shimmer scroll widths; it does not relax text wrapping/containment checks. It checks explicit Tailwind utility availability so a missing ignored-directory source scan cannot produce misleading results. It covers tree/list/detail as well as flow, and user/assistant/stream/pending/steering bubbles. Additional behavior checks cover default preview height, keyboard expansion, unchanged full text, re-collapse, stream update retention and no unnecessary short-content control. Browser requests outside its temporary loopback origin are blocked; no real sessions, model calls or production WS are used.

Existing local dependencies are required; no automatic install/download. `CHROME_BIN` can select Chrome/Chromium. Geometry/screenshot artifacts, if requested through `PI_RESEARCH_LAYOUT_OUTPUT`, belong outside publication or in an ignored local output directory. Screenshots contain synthetic content only. The Node offline suite tests the idempotent overlay installer separately; that is not a substitute for browser geometry.
