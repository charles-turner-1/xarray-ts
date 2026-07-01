/**
 * Recover xarray dimension names from a zarr v3 array.
 *
 * xarray writes named dimensions to the native v3 `dimension_names` metadata
 * field (exposed by zarrita as {@link ZarrArray.dimensionNames}). When absent,
 * xarray falls back to synthetic `phony_dim_*`/`dim_*` names; we mirror that so
 * a Dataset is always well-formed, and surface a warning.
 *
 * @module
 */
import type { ZarrArray } from "../types.js";

/**
 * Return the dimension names for an array, in axis order.
 *
 * Falls back to `${name}_dim_${i}` for any axis without a declared name and
 * warns once, since downstream alignment relies on dimension names.
 */
export function readDims(arr: ZarrArray, name: string): string[] {
  const declared = arr.dimensionNames;
  const ndim = arr.shape.length;
  // A 0-d (scalar) array genuinely has no dimensions, so `[]` is correct rather
  // than a synthetic fallback — don't warn about missing dimension_names.
  if (ndim === 0) return [];
  if (declared && declared.length === ndim && declared.every((d) => d != null)) {
    return declared.slice();
  }
  const dims = Array.from({ length: ndim }, (_, i) => declared?.[i] ?? `${name}_dim_${i}`);
  console.warn(
    `xarray-ts: array "${name}" is missing dimension_names; using synthetic ${JSON.stringify(dims)}.`,
  );
  return dims;
}
