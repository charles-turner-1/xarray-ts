import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as zarr from "zarrita";
import { fromHttp, isLazyCoord, openDataset } from "../src/index.js";
import { makeAuxCoordStore, makeDemoStore, makeScalarCoordStore } from "./fixtures.js";

describe("store openers", () => {
  it("fromHttp returns a zarrita FetchStore", () => {
    const store = fromHttp("https://example.com/data.zarr");
    expect(store).toBeInstanceOf(zarr.FetchStore);
  });
});

describe("label-range selection", () => {
  it("selects an inclusive label range on a DataArray", async () => {
    const ds = await openDataset(await makeDemoStore());
    const da = ds.get("temperature").sel({ x: { start: 200, stop: 300 } });
    expect(da.dims).toEqual(["time", "y", "x"]);
    expect(da.shape).toEqual([3, 2, 2]);
    expect(da.coords["x"]!.values).toEqual([200, 300]);
  });

  it("selects an inclusive label range across a Dataset", async () => {
    const ds = await openDataset(await makeDemoStore());
    const sub = ds.sel({ x: { start: 100, stop: 200 } });
    expect(sub.dims).toEqual({ time: 3, y: 2, x: 2 });
    expect(sub.coords["x"]!.values).toEqual([100, 200]);
  });
});

describe("rename-style metadata operations", () => {
  it("renameVars renames a data variable without touching coordinates", async () => {
    const ds = await openDataset(await makeDemoStore());
    const renamed = ds.renameVars({ temperature: "tas" });

    expect(Object.keys(renamed.data_vars)).toEqual(["tas"]);
    expect(() => renamed.get("temperature")).toThrow(/no variable named "temperature"/);
    expect(renamed.get("tas").dims).toEqual(["time", "y", "x"]);
    expect(Object.keys(renamed.coords).sort()).toEqual(["time", "x", "y"]);
  });

  it("renameVars renames a coordinate and keeps it out of user-visible attrs", async () => {
    const ds = await openDataset(await makeScalarCoordStore());
    const renamed = ds.renameVars({ height: "z" });

    expect(Object.keys(renamed.coords).sort()).toEqual(["time", "z"]);
    expect(Object.keys(renamed.data_vars)).toEqual(["tasmax"]);
    // `coordinates` is decode-time encoding, never surfaced in attrs (xarray parity).
    expect(renamed.get("tasmax").attrs).not.toHaveProperty("coordinates");
  });

  it("renameDims renames dimensions and matching dimension coordinates", async () => {
    const ds = await openDataset(await makeDemoStore());
    const renamed = ds.renameDims({ x: "lon", y: "lat" });

    expect(renamed.dims).toEqual({ time: 3, lat: 2, lon: 4 });
    expect(Object.keys(renamed.coords).sort()).toEqual(["lat", "lon", "time"]);
    expect(renamed.get("temperature").dims).toEqual(["time", "lat", "lon"]);
    expect(renamed.sel({ lon: 200 }).dims).toEqual({ time: 3, lat: 2 });
  });

  it("renameDims renames a dimension that has no coordinate variable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store: Map<string, Uint8Array> = new Map();
    await zarr.create(zarr.root(store), {});
    const arr = await zarr.create(zarr.root(store).resolve("raw"), {
      shape: [2, 3],
      chunkShape: [2, 3],
      dtype: "int16",
    });
    const stride = zarr._zarrita_internal_getStrides([2, 3], "C");
    await zarr.set(arr, null, { data: Int16Array.from([0, 1, 2, 3, 4, 5]), shape: [2, 3], stride });

    const ds = await openDataset(store, { variables: ["raw"] });
    const renamed = ds.renameDims({ raw_dim_0: "a" });

    expect(renamed.dims).toEqual({ a: 2, raw_dim_1: 3 });
    expect(renamed.get("raw").dims).toEqual(["a", "raw_dim_1"]);
  });

  it("DataArray.rename returns a renamed lazy view preserving coords and attrs", async () => {
    const ds = await openDataset(await makeDemoStore());
    const da = ds.get("temperature");
    const renamed = da.rename("tas");

    expect(renamed.name).toBe("tas");
    expect(renamed.dims).toEqual(["time", "y", "x"]);
    expect(renamed.attrs).toEqual(da.attrs);
    expect(Object.keys(renamed.coords).sort()).toEqual(Object.keys(da.coords).sort());
    expect(await renamed.isel({ time: 0 }).values()).toBeInstanceOf(Float32Array);
  });

  it("renameVars/renameDims read no chunks", async () => {
    const store = await makeDemoStore();
    const readSpy = vi.spyOn(store, "get");
    const ds = await openDataset(store);

    readSpy.mockClear();
    ds.renameVars({ temperature: "tas" });
    ds.renameDims({ x: "lon" });
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("throws on bad rename targets", async () => {
    const ds = await openDataset(await makeDemoStore());
    expect(() => ds.renameVars({ salinity: "salt" })).toThrow(/no variable named "salinity"/);
    expect(() => ds.renameVars({ temperature: "x" })).toThrow(/existing variable "x"/);
    expect(() => ds.renameDims({ member: "ensemble" })).toThrow(/no dimension "member"/);
    expect(() => ds.renameVars({ x: "z", y: "z" })).toThrow(/multiple variables to "z"/);
    expect(() => ds.renameDims({ x: "d", y: "d" })).toThrow(/multiple dimensions to "d"/);
  });
});

describe("dataset variable subset operations", () => {
  it("dropVars removes named data variables but keeps coordinates", async () => {
    const ds = await openDataset(await makeDemoStore());
    const sub = ds.dropVars(["temperature"]);

    expect(Object.keys(sub.data_vars)).toEqual([]);
    expect(Object.keys(sub.coords).sort()).toEqual(["time", "x", "y"]);
    expect(sub.dims).toEqual({ time: 3, y: 2, x: 4 });
  });

  it("pickVars keeps a data variable plus its coordinate closure", async () => {
    const ds = await openDataset(await makeDemoStore());
    const sub = ds.pickVars(["temperature"]);

    expect(Object.keys(sub.data_vars)).toEqual(["temperature"]);
    expect(Object.keys(sub.coords).sort()).toEqual(["time", "x", "y"]);
  });

  it("pickVars keeps auxiliary scalar coordinates referenced by kept variables", async () => {
    const ds = await openDataset(await makeScalarCoordStore());
    const sub = ds.pickVars(["tasmax"]);

    expect(Object.keys(sub.data_vars)).toEqual(["tasmax"]);
    expect(Object.keys(sub.coords).sort()).toEqual(["height", "time"]);
  });

  it("pickVars keeps N-d aux coordinates on retained dims even when the picked var doesn't name them", async () => {
    // `pr` has no `coordinates` attr, but lat/lon are defined on (y, x) which pr
    // spans, so xarray keeps them. (The old attr-driven closure dropped them.)
    const ds = await openDataset(await makeAuxCoordStore());
    const sub = ds.pickVars(["pr"]);

    expect(Object.keys(sub.data_vars)).toEqual(["pr"]);
    expect(Object.keys(sub.coords).sort()).toEqual(["lat", "lon", "x", "y"]);
    expect(sub.dims).toEqual({ y: 2, x: 2 });
  });

  it("keeps the CF `coordinates` key out of user-visible attrs (xarray parity)", async () => {
    const ds = await openDataset(await makeScalarCoordStore());
    const attrs = ds.get("tasmax").attrs;

    expect(attrs).not.toHaveProperty("coordinates");
    expect(attrs["units"]).toBe("K");
  });

  it("dropVars removes an aux coordinate with no dangling reference left behind", async () => {
    const ds = await openDataset(await makeScalarCoordStore());
    const sub = ds.dropVars(["height"]);

    expect(Object.keys(sub.coords)).toEqual(["time"]);
    expect(sub.get("tasmax").attrs).not.toHaveProperty("coordinates");
  });

  it("pickVars drops dimensions no longer spanned by any kept variable", async () => {
    const ds = await openDataset(await makeDemoStore());
    const sub = ds.pickVars(["time"]);

    expect(Object.keys(sub.data_vars)).toEqual([]);
    expect(Object.keys(sub.coords)).toEqual(["time"]);
    expect(sub.dims).toEqual({ time: 3 });
  });

  it("dropVars drops dimensions whose variables are all removed", async () => {
    const ds = await openDataset(await makeDemoStore());
    const sub = ds.dropVars(["temperature", "y", "x"]);

    expect(Object.keys(sub.coords)).toEqual(["time"]);
    expect(sub.dims).toEqual({ time: 3 });
  });

  it("dropVars can drop a dimension coordinate while keeping the dimension", async () => {
    const ds = await openDataset(await makeDemoStore());
    const sub = ds.dropVars(["time"]);

    // the dimension survives (temperature still spans it) but its labels are gone
    expect(sub.dims).toEqual({ time: 3, y: 2, x: 4 });
    expect(Object.keys(sub.coords).sort()).toEqual(["x", "y"]);
    expect(Object.keys(sub.data_vars)).toEqual(["temperature"]);
  });

  it("pickVars preserves lazy data that still loads correctly", async () => {
    const store = await makeDemoStore();
    const readSpy = vi.spyOn(store, "get");
    const ds = await openDataset(store);

    readSpy.mockClear();
    const sub = ds.pickVars(["temperature"]);
    expect(readSpy).not.toHaveBeenCalled(); // subsetting reads no chunks

    const values = await sub.get("temperature").values();
    expect(Array.from(values as Float32Array)).toEqual(Array.from({ length: 24 }, (_, i) => i));
  });

  it("returns an empty dataset for pickVars([]) and an unchanged one for dropVars([])", async () => {
    const ds = await openDataset(await makeDemoStore());

    const empty = ds.pickVars([]);
    expect(Object.keys(empty.data_vars)).toEqual([]);
    expect(Object.keys(empty.coords)).toEqual([]);
    expect(empty.dims).toEqual({});

    const same = ds.dropVars([]);
    expect(Object.keys(same.data_vars)).toEqual(["temperature"]);
    expect(Object.keys(same.coords).sort()).toEqual(["time", "x", "y"]);
    expect(same.dims).toEqual({ time: 3, y: 2, x: 4 });
  });

  it("throws on unknown variable names", async () => {
    const ds = await openDataset(await makeDemoStore());
    expect(() => ds.dropVars(["salinity"])).toThrow(/no variable named "salinity"/);
    expect(() => ds.pickVars(["salinity"])).toThrow(/no variable named "salinity"/);
  });
});

describe("lazy auxiliary coordinates", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not read auxiliary coordinate chunks at open (they load on demand)", async () => {
    const store = await makeAuxCoordStore();
    const readSpy = vi.spyOn(store, "get");
    const ds = await openDataset(store);
    const readsAtOpen = readSpy.mock.calls.length;

    const lat = ds.coords["lat"]!;
    expect(isLazyCoord(lat)).toBe(true);
    if (!isLazyCoord(lat)) throw new Error("expected a lazy aux coordinate");
    expect(lat.dims).toEqual(["y", "x"]);

    // The 2-D lat grid is fetched only now, not at open.
    const coord = await lat.load();
    expect(coord.values).toEqual([0, 1, 2, 3]);
    expect(readSpy.mock.calls.length).toBeGreaterThan(readsAtOpen);

    // Dimension coordinates stay eager and synchronous.
    const x = ds.coords["x"]!;
    expect(isLazyCoord(x)).toBe(false);
    if (isLazyCoord(x)) throw new Error("expected an eager dimension coordinate");
    expect(x.values).toEqual([100, 200]);
  });

  it("caches a lazy coordinate's values after the first load", async () => {
    const store = await makeAuxCoordStore();
    const ds = await openDataset(store);
    const lat = ds.coords["lat"]!;
    if (!isLazyCoord(lat)) throw new Error("expected a lazy aux coordinate");

    const readSpy = vi.spyOn(store, "get");
    await lat.load();
    const reads = readSpy.mock.calls.length;
    await lat.load();
    expect(readSpy.mock.calls.length).toBe(reads); // second load reads nothing
  });

  it("rejects label selection by a lazy auxiliary coordinate", async () => {
    const ds = await openDataset(await makeAuxCoordStore());
    expect(() => ds.sel({ lat: 1 })).toThrow(/label selection requires an eager dimension/);
  });
});

describe("coordinate set/reset operations", () => {
  afterEach(() => vi.restoreAllMocks());

  it("setCoords promotes a data variable to a lazy coordinate with no IO", async () => {
    const store = await makeAuxCoordStore();
    const readSpy = vi.spyOn(store, "get");
    const ds = await openDataset(store);

    readSpy.mockClear();
    const promoted = ds.setCoords("pr");
    expect(readSpy).not.toHaveBeenCalled(); // reclassification reads no chunks

    expect(Object.keys(promoted.data_vars)).toEqual(["temp"]);
    expect(Object.keys(promoted.coords).sort()).toEqual(["lat", "lon", "pr", "x", "y"]);
    expect(isLazyCoord(promoted.coords["pr"]!)).toBe(true);
  });

  it("setCoords is idempotent and validates names", async () => {
    const ds = await openDataset(await makeAuxCoordStore());
    const once = ds.setCoords("pr");
    const twice = once.setCoords("pr");
    expect(Object.keys(twice.coords).sort()).toEqual(["lat", "lon", "pr", "x", "y"]);
    expect(Object.keys(twice.data_vars)).toEqual(["temp"]);
    expect(() => ds.setCoords("nope")).toThrow(/no variable named "nope"/);
  });

  it("setCoords accepts multiple names", async () => {
    const ds = await openDataset(await makeAuxCoordStore());
    const promoted = ds.setCoords(["pr", "temp"]);
    expect(Object.keys(promoted.data_vars)).toEqual([]);
    expect(Object.keys(promoted.coords).sort()).toEqual(["lat", "lon", "pr", "temp", "x", "y"]);
  });

  it("resetCoords demotes a coordinate back to a data variable (round-trip)", async () => {
    const ds = await openDataset(await makeAuxCoordStore());
    const round = ds.setCoords("pr").resetCoords("pr");
    expect(Object.keys(round.data_vars).sort()).toEqual(["pr", "temp"]);
    expect(Object.keys(round.coords).sort()).toEqual(["lat", "lon", "x", "y"]);
  });

  it("resetCoords() with no args resets every non-dimension coordinate", async () => {
    const ds = await openDataset(await makeAuxCoordStore());
    const reset = ds.resetCoords();
    // aux coords (lat, lon) are demoted; dimension coords (x, y) stay
    expect(Object.keys(reset.coords).sort()).toEqual(["x", "y"]);
    expect(Object.keys(reset.data_vars).sort()).toEqual(["lat", "lon", "pr", "temp"]);
  });

  it("resetCoords refuses to reset a dimension (index) coordinate", async () => {
    const ds = await openDataset(await makeAuxCoordStore());
    expect(() => ds.resetCoords("x")).toThrow(/cannot reset index \(dimension\) coordinates/);
  });

  it("resetCoords with { drop: true } removes the coordinate entirely", async () => {
    const ds = await openDataset(await makeAuxCoordStore());
    const dropped = ds.resetCoords("lat", { drop: true });
    expect(Object.keys(dropped.coords).sort()).toEqual(["lon", "x", "y"]);
    expect(Object.keys(dropped.data_vars).sort()).toEqual(["pr", "temp"]);
    expect(() => dropped.get("lat")).toThrow(/no variable named "lat"/);
    expect(dropped.dims).toEqual({ y: 2, x: 2 }); // grid dims still spanned
  });
});

describe("console.log / util.inspect repr", () => {
  const plain = (value: unknown) => inspect(value, { colors: false });

  it("renders a DataArray with an xarray-style shape, dtype and chunks", async () => {
    const ds = await openDataset(await makeDemoStore());
    const out = plain(ds.get("temperature"));
    expect(out).toContain("DataArray 'temperature' (time: 3, y: 2, x: 4) float32");
    expect(out).toContain("chunks: (3, 2, 4)");
    expect(out).toContain("long_name: 'air temperature'");
    // Never dump the lazy zarrita handle / raw variable internals.
    expect(out).not.toContain("variable:");
    expect(out).not.toContain("arr:");
  });

  it("reflects the current selection (dropped dims + aligned chunks)", async () => {
    const ds = await openDataset(await makeDemoStore());
    const out = plain(ds.get("temperature").isel({ time: 0 }));
    expect(out).toContain("(y: 2, x: 4)");
    expect(out).toContain("chunks: (2, 4)");
  });

  it("renders a scalar variable as ()", async () => {
    const ds = await openDataset(await makeDemoStore());
    const out = plain(ds.get("time").isel({ time: 0 }));
    expect(out).toContain("DataArray 'time' () float64");
  });

  it("summarises a Dataset's dimensions, coords and data vars", async () => {
    const ds = await openDataset(await makeDemoStore());
    const out = plain(ds);
    expect(out).toContain("Dimensions:  (time: 3, y: 2, x: 4)");
    expect(out).toContain("Coordinates:");
    expect(out).toContain("Data variables:");
    expect(out).toContain("temperature (time, y, x) float32");
    expect(out).toContain("title: 'demo dataset'");
  });
});

describe("missing dimension_names", () => {
  afterEach(() => vi.restoreAllMocks());

  it("falls back to synthetic dimension names and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store: Map<string, Uint8Array> = new Map();
    await zarr.create(zarr.root(store), {});
    const arr = await zarr.create(zarr.root(store).resolve("raw"), {
      shape: [2, 3],
      chunkShape: [2, 3],
      dtype: "int16",
    });
    const stride = zarr._zarrita_internal_getStrides([2, 3], "C");
    await zarr.set(arr, null, { data: Int16Array.from([0, 1, 2, 3, 4, 5]), shape: [2, 3], stride });

    const ds = await openDataset(store, { variables: ["raw"] });
    expect(ds.get("raw").dims).toEqual(["raw_dim_0", "raw_dim_1"]);
    expect(ds.dims).toEqual({ raw_dim_0: 2, raw_dim_1: 3 });
    expect(warn).toHaveBeenCalledOnce();
  });
});
