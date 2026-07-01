/**
 * xarray-ts — a minimal, read-only xarray metadata layer for zarr v3 / icechunk.
 *
 * Reinterprets the zarr arrays produced by serialising an xarray Dataset (e.g.
 * to an icechunk store) into an xarray-shaped object — dims, coordinates, data
 * variables, attributes — that view layers can introspect, while streaming
 * actual slices on demand through zarrita.
 *
 * ```ts
 * import { openDataset, fromIcechunk } from "xarray-ts";
 *
 * const store = await fromIcechunk("https://bucket.s3.amazonaws.com/repo");
 * const ds = await openDataset(store);
 *
 * ds.dims;                       // { time: 365, y: 720, x: 1440 }
 * ds.coords.time.dates();        // Date[] (CF-decoded)
 * const slice = await ds.get("temperature").isel({ time: 0 }).load();
 * slice.data;                    // a (y, x) TypedArray, streamed via zarrita
 * ```
 *
 * @module
 */

export { openDataset, openZarr, openDatatree, fromIcechunk, fromHttp } from "./open.js";
export { Dataset } from "./dataset.js";
export { DataArray, type Chunk, type Scalar } from "./dataarray.js";
export { datasetFromGroup, childArrayNames, type GroupNode } from "./group.js";
export { isLazyCoord } from "./coords.js";
export { NotImplementedError, EnumerationError } from "./errors.js";

export type {
  AnyCoord,
  Attrs,
  Coord,
  FromIcechunkOptions,
  IselIndexer,
  IselSelection,
  Label,
  LabelSlice,
  LazyCoord,
  OpenOptions,
  SelOptions,
  SelSelection,
  SliceArg,
  Store,
  Variable,
  ZarrArray,
  ZarrGroup,
} from "./types.js";
