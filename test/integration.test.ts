import { describe, expect, it } from "vitest";
import { fromIcechunk, openDataset } from "../src/index.js";

const ICECHUNK_URL = process.env["ICECHUNK_TEST_URL"];

// Opt-in: set ICECHUNK_TEST_URL to a real icechunk repo to exercise the
// consolidated-metadata enumeration path and a real streamed slice end-to-end.
describe.skipIf(!ICECHUNK_URL)("integration: real icechunk store", () => {
  it("opens a dataset, enumerates its group, and streams a corner slice", async () => {
    const store = await fromIcechunk(ICECHUNK_URL!);
    const ds = await openDataset(store);

    expect(Object.keys(ds.dims).length).toBeGreaterThan(0);
    const dataVars = Object.keys(ds.data_vars);
    expect(dataVars.length).toBeGreaterThan(0);

    const da = ds.get(dataVars[0]!);
    // Pull a 1-wide corner along every dimension so the test stays small.
    const corner = Object.fromEntries(da.dims.map((d) => [d, { start: 0, stop: 1 }]));
    const chunk = await da.isel(corner).load();
    expect(chunk).toBeTruthy();
  }, 60_000);
});
