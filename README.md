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
npm run export -- https://example.framer.website --out exports/example --max-pages 1
```

The first tracer bullet exports one rendered page by default. Raise `--max-pages` to crawl same-origin links.

## Output

```text
exports/example/
  index.html
  assets/
  manifest.json
```

`manifest.json` lists visited routes, saved assets, skipped responses, and warnings.
