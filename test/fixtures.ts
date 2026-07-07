/**
 * Hermetic in-memory zarr v3 fixtures, built with zarrita into a plain `Map`
 * store (which satisfies zarrita's readable/writable store interface).
 *
 * The demo dataset mirrors a typical xarray-to-zarr layout:
 *   dims      time=3, y=2, x=4
 *   coords    time (CF "days since 2000-01-01"), y, x
 *   data_vars temperature(time, y, x)  with values 0..23 (row-major)
 *
 * @module
 */
import * as zarr from "zarrita";

export type MapStore = Map<string, Uint8Array>;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Build the demo store; consolidates metadata by default (set `false` to omit). */
export async function makeDemoStore(opts: { consolidated?: boolean } = {}): Promise<MapStore> {
  const store: MapStore = new Map();
  await zarr.create(zarr.root(store), { attributes: { title: "demo dataset" } });

  await writeArray(
    store,
    "time",
    "float64",
    [3],
    ["time"],
    {
      units: "days since 2000-01-01",
      calendar: "standard",
    },
    Float64Array.from([0, 1, 2]),
  );

  await writeArray(store, "y", "float64", [2], ["y"], {}, Float64Array.from([10, 20]));
  await writeArray(store, "x", "float64", [4], ["x"], {}, Float64Array.from([100, 200, 300, 400]));

  await writeArray(
    store,
    "temperature",
    "float32",
    [3, 2, 4],
    ["time", "y", "x"],
    { units: "K", long_name: "air temperature" },
    Float32Array.from({ length: 24 }, (_, i) => i),
  );

  if (opts.consolidated ?? true) consolidate(store);
  return store;
}

/**
 * A store with a **non-standard** CF calendar (`360_day`) time coordinate, for
 * exercising `cftime-ts` decoding and label selection on calendars JS `Date`
 * cannot represent. Under `360_day` every month has 30 days, so the raw offsets
 * decode to the first of Jan/Feb/Mar/Apr 2000:
 *   dims      time=4
 *   coords    time (CF "days since 2000-01-01", calendar 360_day = [0,30,60,90])
 *   data_vars tas(time)  (=[280,281,282,283])
 */
export async function make360DayStore(): Promise<MapStore> {
  const store: MapStore = new Map();
  await zarr.create(zarr.root(store), {});

  await writeArray(
    store,
    "time",
    "float64",
    [4],
    ["time"],
    { units: "days since 2000-01-01", calendar: "360_day" },
    Float64Array.from([0, 30, 60, 90]),
  );
  await writeArray(
    store,
    "tas",
    "float32",
    [4],
    ["time"],
    { units: "K" },
    Float32Array.from([280, 281, 282, 283]),
  );

  consolidate(store);
  return store;
}

/**
 * A store with a size-1 dimension (and its dimension coordinate), for exercising
 * `squeeze`:
 *   dims      time=3, level=1, y=2
 *   coords    time (CF "days since 2000-01-01"), level (=[1000]), y
 *   data_vars temperature(time, level, y)  with values 0..5 (row-major)
 */
export async function makeSqueezeStore(): Promise<MapStore> {
  const store: MapStore = new Map();
  await zarr.create(zarr.root(store), {});

  await writeArray(
    store,
    "time",
    "float64",
    [3],
    ["time"],
    { units: "days since 2000-01-01", calendar: "standard" },
    Float64Array.from([0, 1, 2]),
  );
  await writeArray(
    store,
    "level",
    "float64",
    [1],
    ["level"],
    { units: "hPa" },
    Float64Array.from([1000]),
  );
  await writeArray(store, "y", "float64", [2], ["y"], {}, Float64Array.from([10, 20]));

  await writeArray(
    store,
    "temperature",
    "float32",
    [3, 1, 2],
    ["time", "level", "y"],
    { units: "K" },
    Float32Array.from({ length: 6 }, (_, i) => i),
  );

  consolidate(store);
  return store;
}

/**
 * A store for exercising `swapDims`: a data variable that is 1-D along an
 * existing dimension, so it can be promoted to that dimension's coordinate.
 *   dims      x=3, y=2
 *   coords    x (=[0,1,2]), y (=[10,20])
 *   data_vars lon(x) (=[100,110,120]), temp(y, x) with values 0..5 (row-major)
 */
export async function makeSwapDimsStore(): Promise<MapStore> {
  const store: MapStore = new Map();
  await zarr.create(zarr.root(store), {});

  await writeArray(store, "x", "float64", [3], ["x"], {}, Float64Array.from([0, 1, 2]));
  await writeArray(store, "y", "float64", [2], ["y"], {}, Float64Array.from([10, 20]));
  await writeArray(
    store,
    "lon",
    "float64",
    [3],
    ["x"],
    { units: "degrees_east" },
    Float64Array.from([100, 110, 120]),
  );
  await writeArray(
    store,
    "temp",
    "float32",
    [2, 3],
    ["y", "x"],
    { units: "K" },
    Float32Array.from({ length: 6 }, (_, i) => i),
  );

  consolidate(store);
  return store;
}

/**
 * A store with a 1-D *auxiliary* coordinate along an existing dimension, for
 * exercising `DataArray.swapDims` (its target must be a coordinate of the array,
 * not a sibling variable):
 *   dims      x=3, y=2
 *   coords    x (=[0,1,2]), y (=[10,20]), xc(x) (=[100,110,120])
 *   data_vars temp(y, x) with `coordinates: "xc"`, values 0..5 (row-major)
 */
export async function makeAuxDimCoordStore(): Promise<MapStore> {
  const store: MapStore = new Map();
  await zarr.create(zarr.root(store), {});

  await writeArray(store, "x", "float64", [3], ["x"], {}, Float64Array.from([0, 1, 2]));
  await writeArray(store, "y", "float64", [2], ["y"], {}, Float64Array.from([10, 20]));
  await writeArray(
    store,
    "xc",
    "float64",
    [3],
    ["x"],
    { units: "degrees_east" },
    Float64Array.from([100, 110, 120]),
  );
  await writeArray(
    store,
    "temp",
    "float32",
    [2, 3],
    ["y", "x"],
    { units: "K", coordinates: "xc" },
    Float32Array.from({ length: 6 }, (_, i) => i),
  );

  consolidate(store);
  return store;
}

/**
 * A store with a 0-d scalar coordinate, mirroring a CF `height` (e.g. 2 m)
 * referenced by a surface variable's `coordinates` attribute:
 *   dims      time=3
 *   coords    time, height (scalar)
 *   data_vars tasmax(time)  with `coordinates: "height"`
 */
export async function makeScalarCoordStore(): Promise<MapStore> {
  const store: MapStore = new Map();
  await zarr.create(zarr.root(store), {});

  await writeArray(store, "time", "float64", [3], ["time"], {}, Float64Array.from([0, 1, 2]));
  await writeScalar(store, "height", "float64", { units: "m", standard_name: "height" }, 2);
  await writeArray(
    store,
    "tasmax",
    "float32",
    [3],
    ["time"],
    { units: "K", coordinates: "height" },
    Float32Array.from([280, 281, 282]),
  );

  consolidate(store);
  return store;
}

/**
 * A store with 2-D auxiliary coordinates (CF `lat(y, x)`, `lon(y, x)`) referenced
 * by one data variable's `coordinates` attribute, plus a second data variable on
 * the same grid that does *not* name them — exercising xarray's rule that a coord
 * is kept when its dims are a subset of the picked variable's dims:
 *   dims      y=2, x=2
 *   coords    y, x, lat(y, x), lon(y, x)
 *   data_vars temp(y, x) with `coordinates: "lat lon"`, pr(y, x) with no attr
 */
export async function makeAuxCoordStore(): Promise<MapStore> {
  const store: MapStore = new Map();
  await zarr.create(zarr.root(store), {});

  await writeArray(store, "y", "float64", [2], ["y"], {}, Float64Array.from([10, 20]));
  await writeArray(store, "x", "float64", [2], ["x"], {}, Float64Array.from([100, 200]));
  await writeArray(
    store,
    "lat",
    "float64",
    [2, 2],
    ["y", "x"],
    {},
    Float64Array.from([0, 1, 2, 3]),
  );
  await writeArray(
    store,
    "lon",
    "float64",
    [2, 2],
    ["y", "x"],
    {},
    Float64Array.from([4, 5, 6, 7]),
  );
  await writeArray(
    store,
    "temp",
    "float32",
    [2, 2],
    ["y", "x"],
    { coordinates: "lat lon" },
    Float32Array.from([0, 1, 2, 3]),
  );
  await writeArray(store, "pr", "float32", [2, 2], ["y", "x"], {}, Float32Array.from([0, 1, 2, 3]));

  consolidate(store);
  return store;
}

async function writeScalar<D extends zarr.DataType>(
  store: MapStore,
  name: string,
  dtype: D,
  attributes: zarr.Attributes,
  value: zarr.Scalar<D>,
): Promise<void> {
  const arr = await zarr.create(zarr.root(store).resolve(name), {
    shape: [],
    chunkShape: [],
    dtype,
    dimensionNames: [],
    attributes,
  });
  await zarr.set(arr, null, value);
}

async function writeArray<D extends zarr.DataType>(
  store: MapStore,
  name: string,
  dtype: D,
  shape: number[],
  dimensionNames: string[],
  attributes: zarr.Attributes,
  data: zarr.TypedArray<D>,
): Promise<void> {
  const arr = await zarr.create(zarr.root(store).resolve(name), {
    shape,
    chunkShape: shape,
    dtype,
    dimensionNames,
    attributes,
  });
  const stride = zarr._zarrita_internal_getStrides(shape, "C");
  await zarr.set(arr, null, { data, shape, stride });
}

/** Rewrite the root `zarr.json` with v3 consolidated metadata for every child node. */
function consolidate(store: MapStore): void {
  const rootMeta = JSON.parse(decoder.decode(store.get("/zarr.json")!));
  const metadata: Record<string, unknown> = {};
  for (const [key, bytes] of store) {
    if (key === "/zarr.json" || !key.endsWith("/zarr.json")) continue;
    const name = key.slice(1, -"/zarr.json".length);
    metadata[name] = JSON.parse(decoder.decode(bytes));
  }
  rootMeta.consolidated_metadata = { metadata, kind: "inline", must_understand: false };
  store.set("/zarr.json", encoder.encode(JSON.stringify(rootMeta)));
}
