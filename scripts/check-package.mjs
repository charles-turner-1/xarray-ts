import { existsSync, readFileSync } from "node:fs";

const builtEntrypoint = new URL("../dist/index.d.ts", import.meta.url);
const builtOpenModule = new URL("../dist/open.d.ts", import.meta.url);

const entrypoint = existsSync(builtEntrypoint)
  ? readFileSync(builtEntrypoint, "utf8")
  : readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

const openModule = existsSync(builtOpenModule)
  ? readFileSync(builtOpenModule, "utf8")
  : readFileSync(new URL("../src/open.ts", import.meta.url), "utf8");

if (entrypoint.includes('import("icechunk-js")')) {
  throw new Error('Root entrypoint must not reference "icechunk-js".');
}

if (!entrypoint.includes("FromIcechunkOptions")) {
  throw new Error("Root entrypoint must re-export FromIcechunkOptions.");
}

if (openModule.includes('import("icechunk-js").IcechunkStoreOptions')) {
  throw new Error('fromIcechunk must not expose "icechunk-js" types in the root API.');
}

console.log(
  existsSync(builtEntrypoint) ? "Built package surface check passed." : "Source package surface check passed.",
);
