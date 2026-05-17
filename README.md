# framexporter

`framexporter` is a cautious CLI for backing up public Framer sites you own. It renders pages with Playwright, captures same-session network assets, discovers static asset URLs in HTML/CSS, rewrites common references to local files, and writes a static export directory.

## Boundaries

- Works only against public `http`/`https` URLs.
- Does not use private Framer APIs, editor internals, authentication bypasses, or paid-feature circumvention.
- Static exports preserve Framer runtime assets for fidelity.
- Experimental React exports convert rendered static HTML into a Vite/React project, but do not yet infer semantic component props or rebuild complex Framer runtime interactions.
- Reports dynamic or external behavior it cannot localize.

## Usage

```bash
npm install
npm run build
npm run export -- https://example.framer.website --out exports/example
npm run export:react -- exports/example --out exports-react/example
```

The exporter reads `/sitemap.xml` when available, then crawls same-origin links. Use `--max-pages` only when you deliberately want to cap a large export.

## Preview

```bash
npm run preview -- exports/example --port 4173
```

If you omit the export path, preview scans `exports/` and asks which export to serve when the terminal is interactive.

## React Export

```bash
npm run export:react -- exports/example --out exports-react/example --app-name example-site
cd exports-react/example
npm install
npm run dev
```

The React exporter creates a Vite app with route components under `src/pages`, shared exact-match components under `src/components`, a simple pathname router in `src/App.tsx`, copied assets under `public/assets`, and generated CSS under `src/styles/generated.css`.

## Output

```text
exports/example/
  index.html
  assets/
  manifest.json

exports-react/example/
  index.html
  public/assets/
  src/App.tsx
  src/pages/
  src/styles/generated.css
```

`manifest.json` lists sitemap routes, visited routes, saved assets, skipped responses, remaining external URLs, and warnings.
