# Roadmap

## MVP Scope

Core problem: a site owner needs a local backup of their published Framer website without relying on Framer hosting.

Success criteria: a public page can be rendered, saved with assets, opened locally, and audited through a manifest.

## In Scope

- CLI command: `framexporter export <url>`.
- Playwright rendering for public pages.
- Network asset capture for HTML, CSS, JS, images, fonts, SVG, and JSON.
- Static URL discovery for `srcset`, inline styles, and stylesheet `url(...)` references.
- Same-origin crawling with a conservative `--max-pages` limit.
- HTML and CSS URL rewriting for common references.
- Manifest report for saved and skipped resources.

## Explicitly Out of Scope

- Private dashboard export.
- Login bypass, password bypass, or scraping sites the user does not own.
- Framer-to-React or Framer-to-Next conversion.
- Reimplementation of forms, CMS mutations, ecommerce, auth, search, or analytics backends.
- Visual editor or browser extension.

## Next Milestones

1. Add local preview command with a static server.
2. Add screenshot comparison against the source URL.
3. Add CSS source map and nested import handling.
4. Add route-level warnings for forms and external runtime dependencies.
