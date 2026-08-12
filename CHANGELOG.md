# Changelog

## [1.1.3] - 2026-07-23

### Minimized panel — dragging fixed
- The collapsed square can now be dragged all the way to every screen edge. It previously stopped 44px short of the left edge and 24px short of the bottom, because the drag clamp assumed the panel was always at least 80×60px instead of measuring it
- Fixed the square sticking to the cursor: if the mouse button was released outside the browser window the drag never ended, and the panel would then follow the pointer around the page with no button held. Dragging now uses pointer capture, which guarantees the release is delivered
- The panel and its resize handles now respond to touch and pen, not just a mouse
- The panel can no longer be stranded off-screen — it re-clamps itself when its contents change size, when it's minimized or expanded, when the window is resized, and when a tab that was in the background becomes visible

### Automatic updates for existing users
- Updates are applied as soon as Chrome has one, instead of waiting for the extension to go idle
- Open claude.ai tabs now pick up the new version in place. Previously an update orphaned the panel in every open tab: it stayed on screen but stopped updating, and the console filled with "Extension context invalidated" until the tab was reloaded by hand
- Timers in a tab left over from a previous version now stop themselves instead of throwing every 20 seconds

### Fixes
- The "Usage This Week" bar chart never drew its bars — every one collapsed to a 2px stub regardless of its value
- The minimized square's logo now shows the Clautics diamond. It was a `<img>` pointing at the packaged icon, which claude.ai's Content-Security-Policy (`img-src 'self' …`) blocks for content-script-injected images regardless of manifest settings; it is now drawn as inline SVG, which the policy does not restrict
- Usage colors in the popup now follow the light theme instead of always using the dark-theme palette

### Internals
- Shared logic between the popup, the on-page panel, and the background worker moved into a single `src/common.js`, replacing two and three-way duplicated copies of the labels, tier names, percentage color thresholds, countdown and date formatting, and the peak-hours heuristic
- Removed dead code from the on-page panel (a stats renderer whose elements do not exist there)
- Roughly 11% less JavaScript overall, excluding comments
- Rewrote the year heatmap, the streak/average calculation, and the 7-day chart to walk a single date cursor instead of allocating ~1,100 `Date` objects per popup open, and to stop re-scanning a spread `Map` once per column
- The daily-usage prune now runs once a day rather than on every message

## [1.1.2] - 2026-07-21

- Fixed the floating panel's collapsed/minimized button to show the actual Clautics logo instead of a plain dot
- Made the collapsed panel button draggable/moveable (previously only the expanded header could be dragged)
- Hardened the background worker's message listener to reject messages from outside the extension
- Added input length limits and validation to the license activation field
- Debounced usage polling triggered by webRequest completions to avoid hammering claude.ai's API

## [1.1.1] - 2026-07-16

- Added rate limiting to license activation (5 attempts per 15-minute window), mirroring the same fix on the desktop app — protects against a compromised local script brute-forcing license keys and reduces load on Lemon Squeezy's API
- Surfaced the specific activation failure reason (invalid key vs. rate-limited vs. network error) in the popup instead of a single generic message
- Security audit hygiene: removed a leaked GitHub token from git remote config, added .env exclusions to .gitignore, excluded local dev-tooling config (.claude/) from version control

## [1.1.0] - 2026-07-15

- Added drag-to-resize on the floating on-page panel (all edges and corners)
- Panel content now reformats responsively (font size, spacing, bar thickness) to fit whatever size it's resized to, with no leftover empty space
- Minimize now collapses the whole panel to a small status-colored square button instead of just hiding the body
- Manual resizing is session-only and always resets to the default size when the panel is reopened or minimized/expanded
- Added a Compact/Default/Large panel size preset to the toolbar popup's Settings, which sets the panel's permanent default size

