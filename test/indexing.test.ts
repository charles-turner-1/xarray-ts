import { CFDatetime } from "cftime-ts";
import { describe, expect, it } from "vitest";
import { isLazyCoord, openDataset } from "../src/index.js";
import type { Chunk } from "../src/index.js";
import { make360DayStore, makeDemoStore } from "./fixtures.js";

// temperature is row-major over (time, y, x): value at (t, y, x) = t*8 + y*4 + x.

describe("DataArray.isel", () => {
  it("drops a dimension with an integer index and streams the right slice", async () => {
    const ds = await openDataset(await makeDemoStore());
    const da = ds.get("temperature").isel({ time: 0 });
    expect(da.dims).toEqual(["y", "x"]);
    expect(da.shape).toEqual([2, 4]);
    const chunk = (await da.load()) as Chunk;
    expect([...chunk.data]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("keeps a dimension with a slice and slices its coordinate too", async () => {
    const ds = await openDataset(await makeDemoStore());
    const da = ds.get("temperature").isel({ x: { start: 1, stop: 3 } });
    expect(da.dims).toEqual(["time", "y", "x"]);
    expect(da.shape).toEqual([3, 2, 2]);
    expect(da.coords["x"]!.values).toEqual([200, 300]);
  });

  it("composes chained selections", async () => {
    const ds = await openDataset(await makeDemoStore());
    const da = ds.get("temperature").isel({ time: 0 }).isel({ x: 3 });
    expect(da.dims).toEqual(["y"]);
    const chunk = (await da.load()) as Chunk;
    expect([...chunk.data]).toEqual([3, 7]); // (t=0, x=3) for y=0,1
  });

  it("returns a scalar when every dimension is integer-indexed", async () => {
    const ds = await openDataset(await makeDemoStore());
    const value = await ds.get("temperature").isel({ time: 1, y: 1, x: 2 }).values();
    expect(value).toBe(14); // 1*8 + 1*4 + 2
  });
});

describe("DataArray.sel", () => {
  it("resolves exact time labels via the decoded coordinate", async () => {
    const ds = await openDataset(await makeDemoStore());
    const da = ds.get("temperature").sel({ time: new Date("2000-01-02T00:00:00Z") });
    expect(da.dims).toEqual(["y", "x"]);
    const chunk = (await da.load()) as Chunk;
    expect([...chunk.data]).toEqual([8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it("snaps to the nearest label with method: 'nearest'", async () => {
    const ds = await openDataset(await makeDemoStore());
    const da = ds
      .get("temperature")
      .sel({ time: new Date("2000-01-02T06:00:00Z") }, { method: "nearest" });
    const chunk = (await da.load()) as Chunk;
    expect([...chunk.data]).toEqual([8, 9, 10, 11, 12, 13, 14, 15]); // closest to 2000-01-02
  });

  it("selects by a numeric coordinate label", async () => {
    const ds = await openDataset(await makeDemoStore());
    const da = ds.get("temperature").isel({ time: 0 }).sel({ y: 20 });
    expect(da.dims).toEqual(["x"]);
    const chunk = (await da.load()) as Chunk;
    expect([...chunk.data]).toEqual([4, 5, 6, 7]); // y=1 row of t=0
  });

  it("throws on an absent exact label", async () => {
    const ds = await openDataset(await makeDemoStore());
    expect(() => ds.get("temperature").isel({ time: 0 }).sel({ y: 15 })).toThrow(/not found/);
  });
});

describe("DataArray.sel on a non-standard (360_day) calendar", () => {
  it("exposes calendar-aware cftimes and a raw, undecoded coordinate", async () => {
    const ds = await openDataset(await make360DayStore());
    const time = ds.coords["time"]!;
    if (isLazyCoord(time)) throw new Error("expected an eager time coordinate");
    expect(time.isTime).toBe(true);
    expect(time.decoded).toBe(false); // no JS Date for 360_day
    expect(time.calendar).toBe("360_day");
    expect(time.dates()).toBeUndefined();
    expect(time.values).toEqual([0, 30, 60, 90]); // raw encoded numbers
    expect(time.cftimes()?.map((d) => [d?.year, d?.month, d?.day])).toEqual([
      [2000, 1, 1],
      [2000, 2, 1],
      [2000, 3, 1],
      [2000, 4, 1],
    ]);
  });

  it("resolves an exact CFDatetime label", async () => {
    const ds = await openDataset(await make360DayStore());
    const label = new CFDatetime(2000, 3, 1, 0, 0, 0, 0, { calendar: "360_day" });
    const value = await ds.get("tas").sel({ time: label }).values();
    expect(value).toBe(282); // index 2
  });

  it("resolves an exact ISO string label", async () => {
    const ds = await openDataset(await make360DayStore());
    const value = await ds.get("tas").sel({ time: "2000-02-01" }).values();
    expect(value).toBe(281); // index 1
  });

  it("snaps to the nearest CFDatetime with method: 'nearest'", async () => {
    const ds = await openDataset(await make360DayStore());
    // 2000-03-10 (360_day) is nearer to 2000-03-01 (offset 60) than 2000-04-01 (90).
    const label = new CFDatetime(2000, 3, 10, 0, 0, 0, 0, { calendar: "360_day" });
    const value = await ds.get("tas").sel({ time: label }, { method: "nearest" }).values();
    expect(value).toBe(282); // index 2
  });

  it("slices a CFDatetime label range (endpoints inclusive)", async () => {
    const ds = await openDataset(await make360DayStore());
    const start = new CFDatetime(2000, 2, 1, 0, 0, 0, 0, { calendar: "360_day" });
    const stop = new CFDatetime(2000, 3, 1, 0, 0, 0, 0, { calendar: "360_day" });
    const da = ds.get("tas").sel({ time: { start, stop } });
    expect(da.shape).toEqual([2]);
    const chunk = (await da.load()) as Chunk;
    expect([...chunk.data]).toEqual([281, 282]);
  });
});

describe("Dataset.sel / isel", () => {
  it("applies a label selection across the whole Dataset", async () => {
    const ds = await openDataset(await makeDemoStore());
    const sub = ds.sel({ time: new Date("2000-01-01T00:00:00Z") });
    expect(sub.dims).toEqual({ y: 2, x: 4 });
    expect(sub.coords["time"]!.values).toEqual([Date.UTC(2000, 0, 1)]);
    const chunk = (await sub.get("temperature").load()) as Chunk;
    expect([...chunk.data]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("slices a label range (endpoints inclusive)", async () => {
    const ds = await openDataset(await makeDemoStore());
    const sub = ds.isel({ x: { start: 1, stop: 3 } });
    expect(sub.dims).toEqual({ time: 3, y: 2, x: 2 });
    expect(sub.coords["x"]!.values).toEqual([200, 300]);
  });
});
