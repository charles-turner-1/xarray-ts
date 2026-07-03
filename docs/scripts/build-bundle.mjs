/**
 * Bundle the library + demo fixtures into a single browser ESM module that the
 * interactive doc cells import at runtime.
 *
 * We bundle straight from TypeScript source (not the published/`dist` build) so
 * the examples can never drift from the real API. The library source uses
 * NodeNext-style `./foo.js` import specifiers that actually resolve to `./foo.ts`
 * on disk; esbuild does not rewrite those by default, so a tiny resolver plugin
 * maps a relative `.js` import to its sibling `.ts` when one exists.
 */
import { build } from "esbuild";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../playground/entry.ts");
const outfile = resolve(here, "../public/playground.js");

/** Rewrite relative `import "./x.js"` -> `./x.ts` when the .ts sibling exists. */
const tsResolve = {
  name: "ts-js-resolve",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^\.\.?\/.*\.js$/ }, (args) => {
      if (args.kind !== "import-statement" && args.kind !== "dynamic-import") return;
      const tsPath = resolve(dirname(args.importer), args.path.replace(/\.js$/, ".ts"));
      if (existsSync(tsPath)) return { path: tsPath };
      return undefined;
    });
  },
};

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  plugins: [tsResolve],
  logLevel: "info",
});

console.log(`✓ built ${outfile}`);
