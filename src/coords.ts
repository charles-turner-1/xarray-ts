/**
 * Coordinate classification and eager materialisation.
 *
 * xarray's read rule (minimal subset): a variable is a **coordinate** if its
 * name is a dimension name (a dimension coordinate) or if it is referenced by
 * some data variable's `coordinates` attribute (an auxiliary coordinate).
 * Everything else is a **data variable**.
 *
 * Coordinate arrays are small, so we read their values up front and CF-decode
 * time axes. Data variables stay lazy.
 *
 * @module
 */
import * as zarr from "zarrita";
import { decodeTime, isTimeUnits } from "./decode/time.js";
import type { Coord, Variable } from "./types.js";

/** Split variables into coordinate names and data-variable names. */
export function classifyVariables(variables: Iterable<Variable>): {
  coordNames: Set<string>;
  dataVarNames: Set<string>;
} {
  const vars = [...variables];
  const dimNames = new Set<string>();
  const referenced = new Set<string>();
  for (const v of vars) {
    for (const d of v.dims) dimNames.add(d);
    const coordsAttr = v.encoding["coordinates"];
    if (typeof coordsAttr === "string") {
      for (const name of coordsAttr.split(/\s+/).filter(Boolean)) referenced.add(name);
    }
  }
  const coordNames = new Set<string>();
  const dataVarNames = new Set<string>();
  for (const v of vars) {
    // A coordinate is a dimension coordinate, or an auxiliary coordinate named
    // by some data variable's `coordinates` attribute.
    const isCoord = dimNames.has(v.name) || referenced.has(v.name);
    (isCoord ? coordNames : dataVarNames).add(v.name);
  }
  return { coordNames, dataVarNames };
}

/** Materialise an iterable/typed array (including zarrita's custom string/bool arrays) to a plain array. */
function materialize(
  data: ArrayLike<unknown> & Iterable<unknown>,
): Array<number | bigint | string | boolean> {
  return Array.from(data) as Array<number | bigint | string | boolean>;
}

/**
 * Read a coordinate array's values into a flat plain array.
 *
 * A 0-d (scalar) coordinate — e.g. a CF scalar `height` referenced by surface
 * variables — has no chunk to iterate: zarrita returns the bare value. Selecting
 * with `[]` reads it back as a typed `Scalar`, which we wrap as a length-1 array
 * so scalar and N-d coordinates share a representation.
 */
async function readValues(v: Variable): Promise<Array<number | bigint | string | boolean>> {
  if (v.shape.length === 0) {
    const scalar = await zarr.get(v.arr, []);
    return [scalar as number | bigint | string | boolean];
  }
  const chunk = await zarr.get(v.arr, null);
  return materialize(chunk.data as ArrayLike<unknown> & Iterable<unknown>);
}

/**
 * Eagerly load a coordinate variable's values, CF-decoding time axes.
 *
 * Reads the whole array (coords are expected to be small, typically 1-D).
 */
export async function loadCoord(v: Variable): Promise<Coord> {
  const raw = await readValues(v);
  const isTime = isTimeUnits(v.attrs);

  if (isTime) {
    const decoded = decodeTime(raw as Array<number | bigint>, v.attrs);
    return makeCoord(v, decoded.values, true, decoded.decoded);
  }
  return makeCoord(v, raw, false, false);
}

function makeCoord(
  v: Variable,
  values: ReadonlyArray<number | bigint | string | boolean>,
  isTime: boolean,
  decoded: boolean,
): Coord {
  return {
    name: v.name,
    dims: v.dims,
    attrs: v.attrs,
    dtype: v.dtype,
    values,
    isTime,
    decoded,
    dates(): Date[] | undefined {
      if (!isTime || !decoded) return undefined;
      return (values as number[]).map((ms) => new Date(ms));
    },
  };
}
