/**
 * Entry points for opening zarr v3 / icechunk stores as xarray Datasets.
 *
 * @module
 */
import * as zarr from "zarrita";
import type { Dataset } from "./dataset.js";
import { EnumerationError, NotImplementedError } from "./errors.js";
import { childArrayNames, datasetFromGroup } from "./group.js";
import type { OpenOptions, Store } from "./types.js";

/**
 * Open a zarr **v3** store (icechunk-js, a `FetchStore`, an in-memory `Map`, ...)
 * as a {@link Dataset}.
 *
 * Variables are discovered from consolidated metadata when present (a single
 * fetch, no per-array round-trips); otherwise pass `options.variables` with the
 * array names to load. Coordinate arrays are eagerly materialised and time axes
 * CF-decoded; data variables stay lazy.
 */
export async function openDataset(store: Store, options: OpenOptions = {}): Promise<Dataset> {
  const path = normalizePath(options.path);
  const format = options.consolidated ?? "v3";

  let source: zarr.Readable = store;
  let names = options.variables;

  if (!names) {
    const consolidated = await zarr.withMaybeConsolidatedMetadata(
      store as zarr.AsyncReadable,
      { format },
    );
    if ("contents" in consolidated) {
      source = consolidated;
      names = childArrayNames(consolidated.contents(), path);
    }
  }

  if (!names) {
    throw new EnumerationError(
      `xarray-ts: cannot enumerate variables at "${path}". The store has no ` +
        `consolidated metadata and cannot list its children. Pass ` +
        `{ variables: [...] } with the array names to open.`,
    );
  }

  const location = path === "/" ? zarr.root(source) : zarr.root(source).resolve(path);
  const group = await zarr.open(location, { kind: "group" });
  return datasetFromGroup(group, names);
}

/**
 * Alias of {@link openDataset}. Provided for familiarity with xarray's
 * `open_zarr`; both open a zarr v3 store as a Dataset.
 */
export const openZarr = openDataset;

/**
 * Open a hierarchy of nested groups as a tree. **Not implemented here** — nested
 * group / DataTree traversal lives in a separate library that consumes the
 * {@link GroupNode} contract and calls {@link datasetFromGroup} per node.
 */
export function openDatatree(): never {
  throw new NotImplementedError(
    "xarray-ts: openDatatree is intentionally stubbed. Nested-group / DataTree " +
      "traversal is handled by a separate library that builds GroupNode trees " +
      "and calls datasetFromGroup() per node. Use openDataset() for a single group.",
  );
}

/** Open an icechunk repository as a readable store (requires the optional `icechunk-js` peer). */
export async function fromIcechunk(
  url: string,
  options?: import("icechunk-js").IcechunkStoreOptions,
): Promise<Store> {
  const { IcechunkStore } = await import("icechunk-js");
  return IcechunkStore.open(url, options);
}

/** Open a plain zarr v3 store over HTTP via zarrita's `FetchStore`. */
export function fromHttp(
  url: string | URL,
  options?: ConstructorParameters<typeof zarr.FetchStore>[1],
): Store {
  return new zarr.FetchStore(url, options);
}

function normalizePath(path?: string): string {
  if (!path || path === "/") return "/";
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
