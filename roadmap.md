# Roadmap

## MVP Scope

Core problem: a site owner needs a local backup of their published Framer website without relying on Framer hosting.

Success criteria: a public page can be rendered, saved with assets, opened locally, and audited through a manifest.

## Faithful HTML/CSS/JS Export Scope

- CLI command: `framexporter export <url>`.
- Output keeps original Framer HTML, CSS, JavaScript modules, and runtime assets for 1:1 animation behavior.
- Playwright rendering for public pages.
- Network asset capture for HTML, CSS, JS, images, fonts, SVG, and JSON.
- Static URL discovery for `srcset`, inline styles, and stylesheet `url(...)` references.
- Complete sitemap export by default, with optional `--max-pages` safety cap.
- Sitemap seeding from `/sitemap.xml` for Framer routes that are not exposed as visible links.
- HTML and CSS URL rewriting for common references.
- Manifest report for saved and skipped resources.

## Static React Snapshot Scope

- CLI command: `framexporter react [exports/site] --out exports-react/site --motion none`.
- Input is an existing static export folder, not private Framer APIs.
- Output is a Vite/React project with route components, copied assets, and generated CSS.
- Default React output is a static hydrated DOM snapshot without Framer or GSAP animation runtime.
- `--motion approximate` is reserved for the experimental GSAP approximation layer.
- The first compiler pass preserves rendered structure and visual CSS.
- Repeated exact JSX subtrees and conservative repeated JSX shapes are extracted into shared generated components with string props.
- Shared React components receive deterministic heuristic names such as `StatCard`, `ContentCard`, `TextLabel`, and `ResponsiveImage`.

## Explicitly Out of Scope

- Private dashboard export.
- Login bypass, password bypass, or scraping sites the user does not own.
- Reimplementation of forms, CMS mutations, ecommerce, auth, search, or analytics backends.
- Full Framer animation/runtime reconstruction in the first React export pass.
- Visual editor or browser extension.

## Next Milestones

1. Add screenshot comparison against the source URL and generated React export.
2. Add richer prop inference for repeated cards, nav items, and content sections.
3. Split generated React routes with dynamic imports to reduce initial bundle size.
4. Add CSS source map and nested import handling.
5. Add route-level warnings for forms and external runtime dependencies.
