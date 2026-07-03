// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightTypeDoc, { typeDocSidebarGroup } from "starlight-typedoc";
import { visit } from "unist-util-visit";

/** GitHub Pages project-site base path; the site lives under this prefix. */
const BASE = "/xarray-ts";

/**
 * Prepend the site base to root-relative links written in Markdown/MDX content
 * (e.g. `/getting-started/`). Starlight's own nav is already base-aware, but
 * hand-authored `/…` links are emitted verbatim and would 404 under the base.
 */
function rehypeBaseLinks() {
  return (/** @type {import("hast").Root} */ tree) => {
    visit(tree, "element", (node) => {
      if (node.tagName !== "a") return;
      const href = node.properties?.href;
      if (typeof href !== "string") return;
      if (!href.startsWith("/") || href.startsWith("//")) return;
      if (href === BASE || href.startsWith(`${BASE}/`)) return;
      node.properties.href = BASE + href;
    });
  };
}

// https://astro.build/config
export default defineConfig({
  // Project pages URL: https://charles-turner-1.github.io/xarray-ts/
  site: "https://charles-turner-1.github.io",
  base: BASE,
  integrations: [
    starlight({
      title: "xarray-ts",
      description:
        "A minimal, read-only xarray metadata layer for zarr v3 / icechunk in the browser.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/charles-turner-1/xarray-ts",
        },
      ],
      plugins: [
        // Generate the API reference from the library's TSDoc.
        starlightTypeDoc({
          entryPoints: ["../src/index.ts"],
          tsconfig: "../tsconfig.json",
          sidebar: { label: "API reference", collapsed: true },
          typeDoc: {
            excludeInternal: true,
            gitRevision: "main",
          },
        }),
      ],
      sidebar: [
        {
          label: "Start here",
          items: ["index", "install", "getting-started"],
        },
        {
          label: "Guide",
          items: [
            "guide/data-model",
            "guide/coordinates",
            "guide/time",
            "guide/selection",
            "guide/reshaping",
            "guide/loading",
            "guide/opening-stores",
            "guide/nested-groups",
          ],
        },
        // API reference group, populated by starlight-typedoc.
        typeDocSidebarGroup,
      ],
    }),
  ],
  markdown: {
    // MDX inherits these; keep code blocks readable in the guide pages.
    shikiConfig: { themes: { light: "github-light", dark: "github-dark" } },
    rehypePlugins: [rehypeBaseLinks],
  },
});
