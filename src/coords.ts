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
import type { AnyCoord, Coord, LazyCoord, Variable } from "./types.js";

/**
 * Whether a variable is a **dimension coordinate** (1-D and named after its only
 * dimension). These are eagerly materialised at open — they are small and drive
 * the synchronous `.sel()` path; every other coordinate is loaded lazily.
 */
export function isDimensionCoord(v: Variable): boolean {
  return v.dims.length === 1 && v.dims[0] === v.name;
}

/**
 * Wrap a coordinate variable as a {@link LazyCoord}: metadata is available
 * synchronously; values are read (and CF-decoded) on the first `load()`/`values()`
 * call and cached thereafter. Used for auxiliary / scalar / N-d coordinates that
 * are not eagerly materialised at open.
 */
/**
 * Narrow a coordinate from `Dataset.coords` / `DataArray.coords` to a lazy one.
 * An eager {@link Coord} (a dimension coordinate) has synchronous `.values` and
 * `.dates()`; a {@link LazyCoord} exposes `.load()` and must be awaited.
 */
export function isLazyCoord(coord: AnyCoord): coord is LazyCoord {
  return "load" in coord;
}

export function makeLazyCoord(v: Variable): LazyCoord {
  let loaded: Promise<Coord> | undefined;
  const load = (): Promise<Coord> => (loaded ??= loadCoord(v));
  return {
    name: v.name,
    dims: v.dims,
    attrs: v.attrs,
    dtype: v.dtype,
    isTime: isTimeUnits(v.attrs),
    load,
    values: () => load().then((coord) => coord.values),
  };
}

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

/**
 * Return a copy of a coordinate with a new name and its dimensions relabelled
 * through `dimRenames`. Pure metadata: the values are shared, and the `dates()`
 * closure is rebound so time coordinates keep working after the rename.
 */
export function renameCoord(coord: Coord, name: string, dimRenames: Record<string, string>): Coord {
  const values = coord.values;
  return {
    ...coord,
    name,
    dims: coord.dims.map((dim) => dimRenames[dim] ?? dim),
    dates(): Date[] | undefined {
      if (!coord.isTime || !coord.decoded) return undefined;
      return (values as number[]).map((ms) => new Date(ms));
    },
  };
}

/**
 * Return a copy of a lazy coordinate with a new name and its dimensions
 * relabelled through `dimRenames`. The underlying `load()` is preserved (values
 * are still read on demand); the loaded {@link Coord} is relabelled through
 * {@link renameCoord} so a materialised time coordinate keeps working.
 */
export function renameLazyCoord(
  coord: LazyCoord,
  name: string,
  dimRenames: Record<string, string>,
): LazyCoord {
  return {
    ...coord,
    name,
    dims: coord.dims.map((dim) => dimRenames[dim] ?? dim),
    load: () => coord.load().then((loaded) => renameCoord(loaded, name, dimRenames)),
    values: () => coord.values(),
  };
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
