import { describe, expect, it } from "vitest";
import { classifyVariables } from "../src/coords.js";
import type { Variable } from "../src/types.js";

function variable(name: string, dims: string[], attrs: Record<string, unknown> = {}): Variable {
  return {
    name,
    dims,
    attrs,
    shape: dims.map(() => 1),
    dtype: "float32",
    chunks: dims.map(() => 1),
    arr: {} as Variable["arr"],
  };
}

describe("classifyVariables", () => {
  it("treats dimension-named variables as coordinates", () => {
    const { coordNames, dataVarNames } = classifyVariables([
      variable("time", ["time"]),
      variable("x", ["x"]),
      variable("temperature", ["time", "x"]),
    ]);
    expect([...coordNames].sort()).toEqual(["time", "x"]);
    expect([...dataVarNames]).toEqual(["temperature"]);
  });

  it("treats variables named by a `coordinates` attr as auxiliary coordinates", () => {
    const { coordNames, dataVarNames } = classifyVariables([
      variable("time", ["time"]),
      variable("lat", ["y", "x"]),
      variable("lon", ["y", "x"]),
      variable("temp", ["time", "y", "x"], { coordinates: "lat lon" }),
    ]);
    expect([...coordNames].sort()).toEqual(["lat", "lon", "time"]);
    expect([...dataVarNames]).toEqual(["temp"]);
  });
});
