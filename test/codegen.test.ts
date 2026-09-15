import { describe, expect, it } from "vitest";
import { emit, renderPython, renderArg } from "../src/codegen/emit.js";
import * as ir from "../src/codegen/ir.js";
import type { Op } from "../src/codegen/ir.js";

/** Render an op log to its transform tail (no import/open head), for compact assertions. */
const tail = (ops: Op[]): string => renderPython(emit(ops), { header: false });

describe("renderArg", () => {
  it("renders scalars as Python literals", () => {
    expect(renderArg(0)).toBe("0");
    expect(renderArg(1.5)).toBe("1.5");
    expect(renderArg("tas")).toBe('"tas"');
    expect(renderArg(true)).toBe("True");
    expect(renderArg(false)).toBe("False");
    expect(renderArg(null)).toBe("None");
    expect(renderArg(undefined)).toBe("None");
  });

  it("renders arrays as lists and objects as dicts", () => {
    expect(renderArg(["a", "b"])).toBe('["a", "b"]');
    expect(renderArg({ month: "time" })).toBe('{"month": "time"}');
    expect(renderArg([{ a: 1 }, 2])).toBe('[{"a": 1}, 2]');
  });

  it("renders a Date as an ISO string", () => {
    expect(renderArg(new Date("2000-01-01T00:00:00Z"))).toBe('"2000-01-01T00:00:00.000Z"');
  });
});

describe("emit + renderPython (transform tail)", () => {
  it("renders isel with an integer and a slice", () => {
    const ops: Op[] = [ir.select("isel", { time: 0, y: { start: 1, stop: 3 } })];
    expect(tail(ops)).toBe("ds.isel(time=0, y=slice(1, 3))");
  });

  it("renders a stepped slice", () => {
    const ops: Op[] = [ir.select("isel", { x: { start: 0, stop: 8, step: 2 } })];
    expect(tail(ops)).toBe("ds.isel(x=slice(0, 8, 2))");
  });

  it("renders an open-ended slice with None bounds", () => {
    const ops: Op[] = [ir.select("isel", { time: { stop: 2 } })];
    expect(tail(ops)).toBe("ds.isel(time=slice(None, 2))");
  });

  it("renders sel with options as kwargs", () => {
    const ops: Op[] = [ir.select("sel", { y: 20 }, { method: "nearest" })];
    expect(tail(ops)).toBe('ds.sel(y=20, method="nearest")');
  });

  it("falls back to a positional dict for non-identifier dims", () => {
    const ops: Op[] = [ir.select("isel", { "weird-dim": 0 })];
    expect(tail(ops)).toBe('ds.isel({"weird-dim": 0})');
  });

  it("renders rename_vars / rename_dims / drop_vars / pick / set_coords / reset_coords", () => {
    expect(tail([ir.rename("rename_vars", { tas: "temperature" })])).toBe(
      'ds.rename_vars({"tas": "temperature"})',
    );
    expect(tail([ir.rename("rename_dims", { month: "time" })])).toBe(
      'ds.rename_dims({"month": "time"})',
    );
    expect(tail([ir.rename("rename", { month: "time" })])).toBe('ds.rename({"month": "time"})');
    expect(tail([ir.drop(["y", "x"])])).toBe('ds.drop_vars(["y", "x"])');
    expect(tail([ir.pick(["tas", "pr"])])).toBe('ds[["tas", "pr"]]');
    expect(tail([ir.setCoords(["height"])])).toBe('ds.set_coords(["height"])');
    expect(tail([ir.resetCoords(["height"])])).toBe('ds.reset_coords(["height"])');
    expect(tail([ir.resetCoords(["height"], true)])).toBe('ds.reset_coords(["height"], drop=True)');
    expect(tail([ir.resetCoords(undefined)])).toBe("ds.reset_coords()");
    expect(tail([ir.resetCoords(undefined, true)])).toBe("ds.reset_coords(drop=True)");
  });

  it("renders swap_dims and squeeze", () => {
    expect(tail([ir.swapDims({ x: "lon" })])).toBe('ds.swap_dims({"x": "lon"})');
    expect(tail([ir.squeeze()])).toBe("ds.squeeze()");
    expect(tail([ir.squeeze("time")])).toBe('ds.squeeze("time")');
    expect(tail([ir.squeeze(["a", "b"])])).toBe('ds.squeeze(["a", "b"])');
  });

  it("renders a projection to a DataArray and chains onto it", () => {
    const ops: Op[] = [ir.project("temperature"), ir.select("isel", { time: 0 })];
    expect(tail(ops)).toBe('ds["temperature"].isel(time=0)');
  });

  it("renders a DataArray rename — scalar (array) and mapping (dims/coords) forms", () => {
    expect(tail([ir.project("tas"), ir.rename("rename", "temperature")])).toBe(
      'ds["tas"].rename("temperature")',
    );
    expect(tail([ir.project("tas"), ir.rename("rename", { x: "lon" })])).toBe(
      'ds["tas"].rename({"x": "lon"})',
    );
  });
});

describe("renderPython (full script with header)", () => {
  it("emits the import + open head and chains the tail", () => {
    const ops: Op[] = [
      ir.open('"s3://bucket/repo"'),
      ir.select("isel", { time: 0 }),
      ir.rename("rename_vars", { tas: "temperature" }),
    ];
    expect(renderPython(emit(ops))).toBe(
      "import xarray as xr\n" +
        'ds = xr.open_dataset("s3://bucket/repo").isel(time=0).rename_vars({"tas": "temperature"})',
    );
  });

  it("assigns to `da` when the chain projects", () => {
    const ops: Op[] = [ir.open("store"), ir.project("temperature")];
    expect(renderPython(emit(ops))).toBe(
      'import xarray as xr\nda = xr.open_dataset(store)["temperature"]',
    );
  });

  it("forwards open kwargs and honours a source override", () => {
    const ops: Op[] = [ir.open('"ignored"', { group: "sub" })];
    expect(renderPython(emit(ops), { source: '"/tmp/store"' })).toBe(
      'import xarray as xr\nds = xr.open_dataset("/tmp/store", group="sub")',
    );
  });
});
