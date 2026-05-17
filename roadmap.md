# Roadmap

## MVP Scope

Core problem: a site owner needs a local backup of their published Framer website without relying on Framer hosting.

Success criteria: a public page can be rendered, saved with assets, opened locally, and audited through a manifest.

## Static Export Scope

- CLI command: `framexporter export <url>`.
- Playwright rendering for public pages.
- Network asset capture for HTML, CSS, JS, images, fonts, SVG, and JSON.
- Static URL discovery for `srcset`, inline styles, and stylesheet `url(...)` references.
- Complete sitemap export by default, with optional `--max-pages` safety cap.
- Sitemap seeding from `/sitemap.xml` for Framer routes that are not exposed as visible links.
- HTML and CSS URL rewriting for common references.
- Manifest report for saved and skipped resources.

## Experimental React Export Scope

- CLI command: `framexporter react [exports/site] --out exports-react/site`.
- Input is an existing static export folder, not private Framer APIs.
- Output is a Vite/React project with route components, copied assets, and generated CSS.
- The first compiler pass preserves rendered structure and visual CSS.`n- Repeated exact JSX subtrees and conservative repeated JSX shapes are extracted into shared generated components with string props.

## Explicitly Out of Scope

- Private dashboard export.
- Login bypass, password bypass, or scraping sites the user does not own.
- Reimplementation of forms, CMS mutations, ecommerce, auth, search, or analytics backends.
- Full Framer animation/runtime reconstruction in the first React export pass.
- Visual editor or browser extension.

## Next Milestones

1. Add screenshot comparison against the source URL and generated React export.
2. Add semantic names and richer prop inference for repeated cards, nav items, and content sections.
3. Split generated React routes with dynamic imports to reduce initial bundle size.
4. Add CSS source map and nested import handling.
5. Add route-level warnings for forms and external runtime dependencies.
