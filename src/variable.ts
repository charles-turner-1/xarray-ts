/**
 * Read a zarr array into a dtype-erased {@link Variable}.
 *
 * @module
 */
import { readDims } from "./decode/dims.js";
import type { Variable, ZarrArray } from "./types.js";

/** Reinterpret an opened zarrita array as an xarray Variable (metadata only; data stays lazy). */
export function readVariable(arr: ZarrArray, name: string): Variable {
  // Split decode-time metadata (CF `coordinates`) out of the user-visible attrs,
  // mirroring xarray, which surfaces it via `.encoding` rather than `.attrs`.
  const { coordinates, ...attrs } = arr.attrs;
  const encoding = coordinates === undefined ? {} : { coordinates };
  return {
    name,
    dims: readDims(arr, name),
    attrs,
    encoding,
    shape: arr.shape,
    dtype: arr.dtype,
    chunks: arr.chunks,
    arr,
  };
}
