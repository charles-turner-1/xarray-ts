import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as zarr from "zarrita";
import { fromHttp, openDataset } from "../src/index.js";
import { makeDemoStore, makeScalarCoordStore } from "./fixtures.js";

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

  it("renameVars updates coordinate references in attributes", async () => {
    const ds = await openDataset(await makeScalarCoordStore());
    const renamed = ds.renameVars({ height: "z" });

    expect(Object.keys(renamed.coords).sort()).toEqual(["time", "z"]);
    expect(renamed.get("tasmax").attrs["coordinates"]).toBe("z");
  });

  it("renameDims renames dimensions and matching dimension coordinates", async () => {
    const ds = await openDataset(await makeDemoStore());
    const renamed = ds.renameDims({ x: "lon", y: "lat" });

    expect(renamed.dims).toEqual({ time: 3, lat: 2, lon: 4 });
    expect(Object.keys(renamed.coords).sort()).toEqual(["lat", "lon", "time"]);
    expect(renamed.get("temperature").dims).toEqual(["time", "lat", "lon"]);
    expect(renamed.sel({ lon: 200 }).dims).toEqual({ time: 3, lat: 2 });
  });

  it("DataArray.rename returns a renamed lazy view", async () => {
    const ds = await openDataset(await makeDemoStore());
    const renamed = ds.get("temperature").rename("tas");

    expect(renamed.name).toBe("tas");
    expect(renamed.dims).toEqual(["time", "y", "x"]);
    expect(await renamed.isel({ time: 0 }).values()).toBeInstanceOf(Float32Array);
  });

  it("throws on bad rename targets", async () => {
    const ds = await openDataset(await makeDemoStore());
    expect(() => ds.renameVars({ salinity: "salt" })).toThrow(/no variable named "salinity"/);
    expect(() => ds.renameVars({ temperature: "x" })).toThrow(/existing variable "x"/);
    expect(() => ds.renameDims({ member: "ensemble" })).toThrow(/no dimension "member"/);
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
