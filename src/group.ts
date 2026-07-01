/**
 * Group enumeration and the {@link datasetFromGroup} building block.
 *
 * `datasetFromGroup` is the seam that the (separate) nested-group / DataTree
 * library plugs into: it turns a single already-resolved zarr group into a
 * {@link Dataset}, so that library never has to re-implement the xarray
 * metadata interpretation — it just walks the hierarchy and calls this per node.
 *
 * @module
 */
import * as zarr from "zarrita";
import { classifyVariables, isDimensionCoord, loadCoord } from "./coords.js";
import { Dataset, type DatasetParts } from "./dataset.js";
import type { Coord, Variable } from "./types.js";
import { readVariable } from "./variable.js";

/**
 * The contract the external nested-group library implements/consumes. A
 * `GroupNode` is one node of a zarr hierarchy: its own variables (as a
 * {@link Dataset}) plus its child groups. xarray-ts itself only ever produces a
 * single node; recursive assembly lives in that separate library.
 */
export interface GroupNode {
  /** Absolute path of this group within the store (`"/"` for the root). */
  readonly path: string;
  /** This node's variables, interpreted as a flat Dataset. */
  readonly dataset: Dataset;
  /** Child groups keyed by name. */
  readonly children: Record<string, GroupNode>;
}

/**
 * Build a {@link Dataset} from an already-resolved zarr group and the names of
 * its child arrays.
 *
 * This is the reusable core of {@link openDataset} and the integration point
 * for the external DataTree library. Dimension coordinates are eagerly loaded
 * (and time axes CF-decoded); auxiliary / N-d coordinates and data variables
 * stay lazy.
 */
export async function datasetFromGroup(
  group: zarr.Group<zarr.Readable>,
  arrayNames: Iterable<string>,
): Promise<Dataset> {
  const names = [...arrayNames];
  const arrays = await Promise.all(
    names.map((name) => zarr.open(group.resolve(name), { kind: "array" })),
  );

  const vars = new Map<string, Variable>();
  names.forEach((name, i) => vars.set(name, readVariable(arrays[i]!, name)));

  const { coordNames, dataVarNames } = classifyVariables(vars.values());

  // Eagerly materialise only dimension coordinates — they are small and drive the
  // synchronous `.sel()` path. Auxiliary / scalar / N-d coordinates stay lazy and
  // are read on demand via `LazyCoord.load()`.
  const coords = new Map<string, Coord>();
  await Promise.all(
    [...coordNames]
      .filter((name) => isDimensionCoord(vars.get(name)!))
      .map(async (name) => {
        coords.set(name, await loadCoord(vars.get(name)!));
      }),
  );

  const parts: DatasetParts = {
    vars,
    coords,
    coordNames,
    dataVarNames,
    attrs: group.attrs,
  };
  return new Dataset(parts);
}

/**
 * From a consolidated-metadata listing, return the names of arrays that are
 * direct children of `groupPath` (i.e. not nested deeper, which belong to a
 * sub-group handled elsewhere).
 */
export function childArrayNames(
  contents: { path: string; kind: "array" | "group" }[],
  groupPath: string,
): string[] {
  const prefix = groupPath === "/" ? "/" : `${groupPath.replace(/\/$/, "")}/`;
  const names: string[] = [];
  for (const { path, kind } of contents) {
    if (kind !== "array" || !path.startsWith(prefix)) continue;
    const remainder = path.slice(prefix.length);
    if (remainder.length > 0 && !remainder.includes("/")) names.push(remainder);
  }
  return names;
}
