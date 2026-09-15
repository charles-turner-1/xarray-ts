/**
 * Model-guided generation of xarray-ts operation chains for the differential test.
 *
 * A chain is a list of abstract {@link Desc}riptors; {@link interpret} folds them
 * onto a live xarray-ts object, consulting its current dims/vars each step and
 * skipping any descriptor that doesn't apply (so generation stays valid as the
 * shape changes). Both Dataset-level ops and a projection onto a DataArray (with
 * further ops) are generated.
 *
 * `sel` is restricted to the non-time numeric dimension coordinates (`y`/`x`) and
 * always uses `method: "nearest"` — xarray-ts decodes CF time to epoch-ms while
 * xarray uses datetime64, so time labels wouldn't compare, and nearest avoids
 * exact-match failures against a sliced coordinate.
 *
 * @module
 */
import fc from "fast-check";
import { DataArray } from "../../src/dataarray.js";
import { Dataset } from "../../src/dataset.js";

/** A live xarray-ts object — a Dataset, or a DataArray once the chain has projected. */
export type XObj = Dataset | DataArray;

/** One abstract operation; numeric params are taken modulo the live state at apply time. */
export type Desc =
  | { readonly t: "iselInt"; readonly dim: number; readonly pos: number }
  | { readonly t: "iselSlice"; readonly dim: number; readonly a: number; readonly b: number }
  | { readonly t: "sel"; readonly coord: number; readonly label: number }
  | { readonly t: "drop"; readonly v: number }
  | { readonly t: "pick"; readonly v: number }
  | { readonly t: "rename"; readonly v: number }
  | { readonly t: "project"; readonly v: number }
  | { readonly t: "squeeze" };

const SEL_COORDS = ["y", "x"] as const;
// Labels that are exact coord values or *unambiguously* nearest one of them —
// never an exact midpoint. Nearest-selection tie-breaking at an equidistant point
// is a separate xarray-ts fidelity question (see charles-turner-1/xarray-ts#41),
// not what this codegen test targets.
const SEL_LABELS: Record<(typeof SEL_COORDS)[number], number[]> = {
  y: [10, 12, 18, 20],
  x: [100, 220, 280, 400],
};

/** A fast-check arbitrary for a chain of 1–7 descriptors. */
export const chainArb: fc.Arbitrary<Desc[]> = fc.array(
  fc.oneof(
    fc.record({ t: fc.constant("iselInt" as const), dim: fc.nat(7), pos: fc.nat(7) }),
    fc.record({ t: fc.constant("iselSlice" as const), dim: fc.nat(7), a: fc.nat(7), b: fc.nat(7) }),
    fc.record({ t: fc.constant("sel" as const), coord: fc.nat(7), label: fc.nat(7) }),
    fc.record({ t: fc.constant("drop" as const), v: fc.nat(7) }),
    fc.record({ t: fc.constant("pick" as const), v: fc.nat(7) }),
    fc.record({ t: fc.constant("rename" as const), v: fc.nat(7) }),
    fc.record({ t: fc.constant("project" as const), v: fc.nat(7) }),
    fc.record({ t: fc.constant("squeeze" as const) }),
  ),
  { minLength: 1, maxLength: 7 },
);

/** `[name, size]` for each current dimension of a Dataset or DataArray. */
function dimEntries(obj: XObj): [string, number][] {
  if (obj instanceof Dataset) return Object.entries(obj.dims);
  return obj.dims.map((d, i) => [d, obj.shape[i]!]);
}

/** Fold a descriptor chain onto the base Dataset, returning the final object. */
export function interpret(base: Dataset, descs: readonly Desc[]): XObj {
  let obj: XObj = base;
  let fresh = 0;
  const freshName = () => `v${fresh++}`;

  for (const d of descs) {
    const dims = dimEntries(obj);
    const projected = obj instanceof DataArray;
    const vars = obj instanceof Dataset ? Object.keys(obj.data_vars) : [];

    switch (d.t) {
      case "iselInt": {
        if (dims.length === 0) break;
        const [name, size] = dims[d.dim % dims.length]!;
        if (size < 1) break;
        obj = obj.isel({ [name]: d.pos % size });
        break;
      }
      case "iselSlice": {
        if (dims.length === 0) break;
        const [name, size] = dims[d.dim % dims.length]!;
        const a = d.a % (size + 1);
        const b = Math.max(a, d.b % (size + 1));
        obj = obj.isel({ [name]: { start: a, stop: b } });
        break;
      }
      case "sel": {
        const present = SEL_COORDS.filter((c) => dims.some(([n, size]) => n === c && size > 0));
        if (present.length === 0) break;
        const c = present[d.coord % present.length]!;
        const labels = SEL_LABELS[c];
        obj = obj.sel({ [c]: labels[d.label % labels.length]! }, { method: "nearest" });
        break;
      }
      case "drop": {
        if (projected || vars.length === 0) break;
        obj = (obj as Dataset).dropVars([vars[d.v % vars.length]!]);
        break;
      }
      case "pick": {
        if (projected || vars.length === 0) break;
        obj = (obj as Dataset).pickVars([vars[d.v % vars.length]!]);
        break;
      }
      case "rename": {
        if (projected) {
          obj = (obj as DataArray).rename(freshName());
        } else if (vars.length > 0) {
          obj = (obj as Dataset).renameVars({ [vars[d.v % vars.length]!]: freshName() });
        }
        break;
      }
      case "project": {
        if (projected || vars.length === 0) break;
        obj = (obj as Dataset).get(vars[d.v % vars.length]!);
        break;
      }
      case "squeeze": {
        obj = obj.squeeze();
        break;
      }
    }
  }
  return obj;
}
