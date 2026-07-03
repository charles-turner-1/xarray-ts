# xarray-ts docs

The documentation site for `xarray-ts`, built with [Astro
Starlight](https://starlight.astro.build/). It is a self-contained sub-project
(its own `package.json`) and does **not** affect the published npm package.

## What's here

- **Guide + reference** — hand-written guide pages in `src/content/docs/`, plus
  an **API reference generated from the library's TSDoc** via `starlight-typedoc`
  (regenerated on every build into `src/content/docs/api/`, git-ignored).
- **Live, editable code cells** — `RunnableCell.astro` + `runnable-cells.ts` +
  `runner.ts`. A vanilla-TS Astro island (no UI framework): a CodeMirror editor
  and a Run button that transpiles the cell with sucrase and executes it against
  a browser bundle of the library. Everything runs **in the browser, offline** —
  the demo datasets are the in-memory zarr stores from `test/fixtures.ts`.
- **The bundle** — `scripts/build-bundle.mjs` uses esbuild to bundle the library
  source (`../src`) + fixtures into `public/playground.js` (git-ignored). It is
  rebuilt automatically before `dev`/`build`, so examples always track `src/`.

## Commands

```sh
npm install          # from the repo root: npm ci && (cd docs && npm ci)
npm run dev          # bundle + start the dev server
npm run build        # bundle + generate API reference + build static site
npm run verify       # run every cell's real code against the built bundle
npm run preview      # preview the production build locally
```

`npm run verify` requires a prior `npm run build` (it needs
`public/playground.js`). CI runs `build` then `verify` and deploys `dist/` to
GitHub Pages (see `.github/workflows/docs.yml`).
