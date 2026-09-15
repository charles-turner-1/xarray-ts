/**
 * Differential property test: for random xarray-ts operation chains, emit the
 * xarray Python, run it against *real* xarray via the {@link Oracle}, and assert
 * the two agree on structure (dims, data-var and coordinate names) and on a
 * per-data-variable value spot-check (shape + sum/first/last).
 *
 * Opt-in — needs a Python env with xarray/zarr (run `pixi run test-differential`).
 * Skips itself cleanly if `python -c "import xarray"` fails.
 *
 * @module
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, it } from "vitest";
import { openDataset } from "../../src/open.js";
import { DataArray } from "../../src/dataarray.js";
import { Dataset } from "../../src/dataset.js";
import { makeDemoStore } from "../fixtures.js";
import { chainArb, interpret, type XObj } from "./model.js";
import { Oracle, type OracleResult, type Sig } from "./oracle.js";
import { dumpStore, removeStore } from "./store-dump.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ORACLE_PY = join(HERE, "oracle.py");
const PYTHON = "python";

/** Whether a Python interpreter with xarray is reachable (else the suite skips). */
function xarrayAvailable(): boolean {
  try {
    execFileSync(PYTHON, ["-c", "import xarray, zarr"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

interface Norm {
  kind: "dataset" | "dataarray";
  name?: string | null;
  dims: Record<string, number>;
  vars: string[];
  coords: string[];
  sigs: Record<string, Sig>;
}

const SELF = "__self__";

function sigFromValues(shape: number[], data: unknown): Sig {
  if (typeof data === "number" || typeof data === "bigint") {
    const v = Number(data);
    return { shape, sum: v, first: v, last: v };
  }
  const arr = data as ArrayLike<number | bigint>;
  if (arr.length === 0) return { shape, sum: null, first: null, last: null };
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += Number(arr[i]);
  return { shape, sum, first: Number(arr[0]), last: Number(arr[arr.length - 1]) };
}

/**
 * Value signature of one array, skipping the load for a zero-size selection:
 * zarrita throws on an empty read where xarray returns an empty array, and the
 * oracle reports a null signature for those anyway — so structure still compares.
 */
async function sigOf(da: DataArray): Promise<Sig> {
  const shape = da.shape;
  if (shape.includes(0)) return { shape, sum: null, first: null, last: null };
  return sigFromValues(shape, await da.values());
}

/** The xarray-ts side of the comparison (loads data-variable values). */
async function normXts(obj: XObj): Promise<Norm> {
  if (obj instanceof Dataset) {
    const vars = Object.keys(obj.data_vars).sort();
    const sigs: Record<string, Sig> = {};
    for (const name of vars) {
      sigs[name] = await sigOf(obj.data_vars[name]!);
    }
    return { kind: "dataset", dims: obj.dims, vars, coords: Object.keys(obj.coords).sort(), sigs };
  }
  const da = obj as DataArray;
  const dims = Object.fromEntries(da.dims.map((d, i) => [d, da.shape[i]!]));
  return {
    kind: "dataarray",
    name: da.name,
    dims,
    vars: [],
    coords: Object.keys(da.coords).sort(),
    sigs: { [SELF]: await sigOf(da) },
  };
}

/** The xarray side of the comparison, from an oracle reply. */
function normOracle(res: OracleResult): Norm {
  if (res.kind === "dataset") {
    return {
      kind: "dataset",
      dims: res.dims!,
      vars: [...res.data_vars!].sort(),
      coords: [...res.coords!].sort(),
      sigs: res.sig as Record<string, Sig>,
    };
  }
  return {
    kind: "dataarray",
    name: res.name ?? null,
    dims: res.dims!,
    vars: [],
    coords: [...res.coords!].sort(),
    sigs: { [SELF]: res.sig as Sig },
  };
}

const approx = (a: number | null, b: number | null): boolean =>
  a === null || b === null ? a === b : Math.abs(a - b) <= 1e-6 * (1 + Math.abs(b));

/** Compare the two sides; return a human-readable reason on mismatch, or null if equal. */
function diff(xts: Norm, ora: Norm): string | null {
  if (xts.kind !== ora.kind) return `kind: ${xts.kind} vs ${ora.kind}`;
  if (xts.kind === "dataarray" && xts.name !== ora.name) return `name: ${xts.name} vs ${ora.name}`;
  if (JSON.stringify(xts.dims) !== JSON.stringify(ora.dims))
    return `dims: ${JSON.stringify(xts.dims)} vs ${JSON.stringify(ora.dims)}`;
  if (xts.vars.join(",") !== ora.vars.join(",")) return `data_vars: [${xts.vars}] vs [${ora.vars}]`;
  if (xts.coords.join(",") !== ora.coords.join(","))
    return `coords: [${xts.coords}] vs [${ora.coords}]`;
  const keys = new Set([...Object.keys(xts.sigs), ...Object.keys(ora.sigs)]);
  for (const k of keys) {
    const a = xts.sigs[k];
    const b = ora.sigs[k];
    if (!a || !b) return `signature key "${k}" present on only one side`;
    if (JSON.stringify(a.shape) !== JSON.stringify(b.shape))
      return `"${k}" shape: ${JSON.stringify(a.shape)} vs ${JSON.stringify(b.shape)}`;
    if (!approx(a.sum, b.sum) || !approx(a.first, b.first) || !approx(a.last, b.last))
      return `"${k}" values: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  }
  return null;
}

describe.skipIf(!xarrayAvailable())("differential: xarray-ts codegen vs real xarray", () => {
  let base: Dataset;
  let storeDir: string;
  let oracle: Oracle;

  beforeAll(async () => {
    const store = await makeDemoStore();
    storeDir = dumpStore(store);
    base = await openDataset(store);
    oracle = new Oracle(ORACLE_PY, storeDir, PYTHON);
  });

  afterAll(() => {
    oracle?.close();
    if (storeDir) removeStore(storeDir);
  });

  it("agrees on structure and a value spot-check for random op chains", async () => {
    await fc.assert(
      fc.asyncProperty(chainArb, async (descs) => {
        const obj = interpret(base, descs);
        const code = obj.toPython({ header: false });

        const res = await oracle.eval(code);
        if (!res.ok) throw new Error(`xarray raised for \`${code}\`: ${res.error}`);

        const reason = diff(await normXts(obj), normOracle(res));
        if (reason) throw new Error(`mismatch for \`${code}\`\n  ${reason}`);
      }),
      { numRuns: 500 },
    );
  });
});
