import { describe, expect, it } from "vitest";
import { NotImplementedError, openDataset, openDatatree } from "../src/index.js";
import { makeDemoStore } from "./fixtures.js";

describe("openDataset", () => {
  it("reconstructs dims, coords, data_vars and attrs from consolidated metadata", async () => {
    const ds = await openDataset(await makeDemoStore());
    expect(ds.dims).toEqual({ time: 3, y: 2, x: 4 });
    expect(Object.keys(ds.coords).sort()).toEqual(["time", "x", "y"]);
    expect(Object.keys(ds.data_vars)).toEqual(["temperature"]);
    expect(ds.attrs["title"]).toBe("demo dataset");
    expect(ds.get("temperature").attrs["long_name"]).toBe("air temperature");
  });

  it("eagerly materialises coordinates and CF-decodes the time axis", async () => {
    const ds = await openDataset(await makeDemoStore());
    expect(ds.coords["y"]!.values).toEqual([10, 20]);
    expect(ds.coords["x"]!.values).toEqual([100, 200, 300, 400]);

    const time = ds.coords["time"]!;
    expect(time.isTime).toBe(true);
    expect(time.decoded).toBe(true);
    expect(time.values).toEqual([
      Date.UTC(2000, 0, 1),
      Date.UTC(2000, 0, 2),
      Date.UTC(2000, 0, 3),
    ]);
    expect(time.dates()?.[1]?.toISOString()).toBe("2000-01-02T00:00:00.000Z");
  });

  it("enumerates via an explicit variable list when no consolidated metadata exists", async () => {
    const store = await makeDemoStore({ consolidated: false });
    const ds = await openDataset(store, { variables: ["time", "y", "x", "temperature"] });
    expect(ds.dims).toEqual({ time: 3, y: 2, x: 4 });
    expect(Object.keys(ds.data_vars)).toEqual(["temperature"]);
  });

  it("throws a helpful error when variables cannot be enumerated", async () => {
    const store = await makeDemoStore({ consolidated: false });
    await expect(openDataset(store)).rejects.toThrow(/cannot enumerate/);
  });

  it("stubs openDatatree with a NotImplementedError", () => {
    expect(() => openDatatree()).toThrow(NotImplementedError);
  });
});
