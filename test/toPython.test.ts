import { describe, expect, it } from "vitest";
import { openDataset } from "../src/open.js";
import { makeDemoStore } from "./fixtures.js";

// The demo store: dims time=3, y=2, x=4; dim-coords time/y/x; data var temperature(time, y, x).
// It is an in-memory Map (no URL), so the emitted open head uses the `store` placeholder.
const HEAD = 'xr.open_dataset(store, engine="zarr")';

describe("Dataset.toPython (op-log threading)", () => {
  it("starts empty and records nothing until a transform is applied", async () => {
    const ds = await openDataset(await makeDemoStore());
    expect(ds.ops).toHaveLength(1); // just the open head
    expect(ds.toPython()).toBe(`import xarray as xr\nds = ${HEAD}`);
  });

  it("threads a chain of Dataset transforms verbatim", async () => {
    const ds = await openDataset(await makeDemoStore());
    const out = ds.isel({ time: 0 }).renameVars({ temperature: "temp" }).dropVars(["y"]);

    expect(out.toPython({ header: false })).toBe(
      'ds.isel(time=0).rename_vars({"temperature": "temp"}).drop_vars(["y"])',
    );
    expect(out.toPython()).toBe(
      `import xarray as xr\nds = ${HEAD}` +
        '.isel(time=0).rename_vars({"temperature": "temp"}).drop_vars(["y"])',
    );
    // The source Dataset is unchanged (immutability of the log).
    expect(ds.toPython({ header: false })).toBe("ds");
  });

  it("records sel verbatim (labels + options), not the lowered isel", async () => {
    const ds = await openDataset(await makeDemoStore());
    expect(ds.sel({ y: 20 }).toPython({ header: false })).toBe("ds.sel(y=20)");
    expect(ds.sel({ y: 21 }, { method: "nearest" }).toPython({ header: false })).toBe(
      'ds.sel(y=21, method="nearest")',
    );
  });

  it("renders isel slices and pickVars", async () => {
    const ds = await openDataset(await makeDemoStore());
    expect(ds.isel({ x: { start: 1, stop: 3 } }).toPython({ header: false })).toBe(
      "ds.isel(x=slice(1, 3))",
    );
    expect(ds.pickVars(["temperature"]).toPython({ header: false })).toBe('ds[["temperature"]]');
  });

  it("records squeeze as squeeze, not the lowered isel", async () => {
    const ds = await openDataset(await makeDemoStore());
    const squeezed = ds.isel({ y: { start: 0, stop: 1 } }).squeeze("y");
    expect(squeezed.toPython({ header: false })).toBe('ds.isel(y=slice(0, 1)).squeeze("y")');
  });

  it("honours a source override for the open head", async () => {
    const ds = await openDataset(await makeDemoStore());
    expect(ds.isel({ time: 0 }).toPython({ source: '"/data/demo.zarr"' })).toBe(
      'import xarray as xr\nds = xr.open_dataset("/data/demo.zarr", engine="zarr").isel(time=0)',
    );
  });
});

describe("DataArray.toPython (projection chains)", () => {
  it("projects with get() and assigns to `da`", async () => {
    const ds = await openDataset(await makeDemoStore());
    const da = ds.get("temperature");
    expect(da.toPython({ header: false })).toBe('ds["temperature"]');
    expect(da.toPython()).toBe(`import xarray as xr\nda = ${HEAD}["temperature"]`);
  });

  it("threads DataArray transforms after a projection", async () => {
    const ds = await openDataset(await makeDemoStore());
    const out = ds.get("temperature").isel({ time: 0 }).rename("temp");
    expect(out.toPython({ header: false })).toBe('ds["temperature"].isel(time=0).rename("temp")');
  });

  it("does not log bulk-accessor views (data_vars)", async () => {
    const ds = await openDataset(await makeDemoStore());
    expect(ds.data_vars.temperature!.ops).toHaveLength(0);
  });
});
