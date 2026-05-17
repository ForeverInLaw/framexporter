# framexporter

`framexporter` is a cautious CLI for backing up public Framer sites you own. It renders pages with Playwright, captures same-session network assets, discovers static asset URLs in HTML/CSS, rewrites common references to local files, and writes a static export directory.

## Boundaries

- Works only against public `http`/`https` URLs.
- Does not use private Framer APIs, editor internals, authentication bypasses, or paid-feature circumvention.
- Does not convert Framer output into clean React, Next.js, or Astro code.
- Reports dynamic or external behavior it cannot localize.

## Usage

```bash
npm install
npm run build
npm run export -- https://example.framer.website --out exports/example
```

The exporter reads `/sitemap.xml` when available, then crawls same-origin links. Use `--max-pages` only when you deliberately want to cap a large export.

## Output

```text
exports/example/
  index.html
  assets/
  manifest.json
```

`manifest.json` lists sitemap routes, visited routes, saved assets, skipped responses, remaining external URLs, and warnings.
