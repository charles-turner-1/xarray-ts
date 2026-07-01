import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as zarr from "zarrita";
import { fromHttp, openDataset } from "../src/index.js";
import { makeDemoStore } from "./fixtures.js";

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
