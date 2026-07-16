# Changelog

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

