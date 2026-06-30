/**
 * Read a zarr array into a dtype-erased {@link Variable}.
 *
 * @module
 */
import { readDims } from "./decode/dims.js";
import type { Variable, ZarrArray } from "./types.js";

/** Reinterpret an opened zarrita array as an xarray Variable (metadata only; data stays lazy). */
export function readVariable(arr: ZarrArray, name: string): Variable {
  return {
    name,
    dims: readDims(arr, name),
    attrs: arr.attrs,
    shape: arr.shape,
    dtype: arr.dtype,
    chunks: arr.chunks,
    arr,
  };
}
