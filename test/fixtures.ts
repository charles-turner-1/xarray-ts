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
