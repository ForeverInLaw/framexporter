# framexporter

`framexporter` is a cautious CLI for backing up public Framer sites you own. It renders pages with Playwright, captures same-session network assets, discovers static asset URLs in HTML/CSS, rewrites common references to local files, and writes a static export directory.

## Boundaries

- Works only against public `http`/`https` URLs.
- Does not use private Framer APIs, editor internals, authentication bypasses, or paid-feature circumvention.
- Static exports preserve Framer runtime assets for fidelity.
- Experimental React exports convert rendered static HTML into a Vite/React project, but do not yet infer semantic component props or rebuild complex Framer runtime interactions.
- Reports dynamic or external behavior it cannot localize.

## !!! Note
React export is currently broken. I might drop support for this feature since reverse-engineering every bundle is a massive time sink, and frankly, I'm too lazy for that.

## Usage

```bash
npm install
npm run build
npm run export https://example.com
npm run export:react exports/example.com
```

Without `--out`, `export` writes to `exports/<hostname>` and `export:react` writes to `exports-react/<input-folder-name>`. The exporter reads `/sitemap.xml` when available, then crawls same-origin links. Use `--max-pages` only when you deliberately want to cap a large export. Static export renders with a default concurrency of 5 pages at a time; raise it with `--render-concurrency 10` if the machine and target site can handle it.

## Preview

```bash
npm run preview -- exports/example.com --port 4173
```

If you omit the export path, preview scans `exports/` and asks which export to serve when the terminal is interactive.

## Export Modes

- `npm run export` writes a faithful HTML/CSS/JS static export with the original Framer runtime assets. Use this for 1:1 animation fidelity.
- `npm run export:react exports/example.com` writes a Vite/React static DOM snapshot without Framer or GSAP animation runtime. Use this for editable React structure.
- `none` is the default React motion mode. Use `npm run export:react exports/example.com approximate` for the experimental GSAP approximation layer.

## React Export

```bash
npm run export:react exports/example.com
cd exports-react/example.com
npm install
npm run dev
```

The React exporter creates a Vite app with route components under `src/pages`, shared exact-match, prop-inferred, and heuristically named components under `src/components`, a simple pathname router in `src/App.tsx`, copied assets under `public/assets`, and generated CSS under `src/styles/generated.css`. By default it removes animation runtime code and captures the hydrated page in its final visible state.

## Output

```text
exports/example.com/
  index.html
  assets/
  manifest.json

exports-react/example.com/
  index.html
  public/assets/
  src/App.tsx
  src/pages/
  src/styles/generated.css
```

`manifest.json` lists sitemap routes, visited routes, saved assets, skipped responses, remaining external URLs, and warnings.
