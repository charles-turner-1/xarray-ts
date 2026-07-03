/**
 * Verification harness: extract every RunnableCell's source from the docs and
 * run it through the real runner (sucrase transpile + execute + format) against
 * the built playground bundle. Catches broken examples before they ship.
 *
 * Run after `npm run build` (needs public/playground.js):
 *   node scripts/verify-cells.mjs
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runAgainst } from "../src/components/runner.ts";

const here = dirname(fileURLToPath(import.meta.url));
const docsRoot = resolve(here, "../src/content/docs");
const bundleUrl = pathToFileURL(resolve(here, "../public/playground.js")).href;

const mod = await import(bundleUrl);

/** Recursively collect .mdx files. */
async function mdxFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await mdxFiles(p)));
    else if (entry.name.endsWith(".mdx")) out.push(p);
  }
  return out;
}

/** Pull every `code={` … `}` template-literal snippet out of an MDX file. */
function extractSnippets(source) {
  const snippets = [];
  const re = /code=\{`([\s\S]*?)`\}/g;
  let m;
  while ((m = re.exec(source)) !== null) snippets.push(m[1]);
  return snippets;
}

let total = 0;
let failed = 0;

for (const file of (await mdxFiles(docsRoot)).sort()) {
  const source = await readFile(file, "utf8");
  const snippets = extractSnippets(source);
  if (snippets.length === 0) continue;
  const rel = relative(docsRoot, file);
  for (let i = 0; i < snippets.length; i++) {
    total++;
    const result = await runAgainst(mod, snippets[i]);
    const tag = `${rel} · cell ${i + 1}`;
    if (result.error) {
      failed++;
      console.error(`✗ ${tag}\n${indent(result.error)}\n`);
    } else {
      const preview =
        result.result !== undefined
          ? firstLine(result.result)
          : result.logs.map((l) => firstLine(l.text)).join(" | ") || "(no output)";
      console.log(`✓ ${tag} → ${preview}`);
    }
  }
}

console.log(`\n${total - failed}/${total} cells ran cleanly.`);
process.exit(failed === 0 ? 0 : 1);

function firstLine(text) {
  const line = String(text).split("\n")[0];
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function indent(text) {
  return text
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}
