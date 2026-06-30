/**
 * Selection helpers: turn user indexers/labels into positional zarr slices.
 *
 * @module
 */
import type * as zarr from "zarrita";
import type { Coord, Label, LabelSlice, SelOptions, SliceArg } from "./types.js";

/** Whether a `.sel` value is a label range (`{start?, stop?}`) rather than a scalar label. */
export function isLabelSlice(label: unknown): label is LabelSlice {
  return (
    typeof label === "object" &&
    label !== null &&
    !(label instanceof Date) &&
    ("start" in label || "stop" in label)
  );
}

/** Convert a zarr slice (with nullable fields) to a sparse {@link SliceArg}. */
export function toSliceArg(s: zarr.Slice): SliceArg {
  return {
    ...(s.start != null ? { start: s.start } : {}),
    ...(s.stop != null ? { stop: s.stop } : {}),
    ...(s.step != null ? { step: s.step } : {}),
  };
}

/** A fully-resolved slice with a concrete length. */
export interface ResolvedSlice {
  start: number;
  stop: number;
  step: number;
  length: number;
}

/** Convert a user {@link SliceArg} (or `undefined` = whole axis) to a zarr slice. */
export function toZarrSlice(arg?: SliceArg): zarr.Slice {
  return {
    start: arg?.start ?? null,
    stop: arg?.stop ?? null,
    step: arg?.step ?? null,
  };
}

/** Resolve a (possibly open-ended, possibly negative) zarr slice against a dimension size. */
export function resolveSlice(s: zarr.Slice, size: number): ResolvedSlice {
  const step = s.step ?? 1;
  if (step === 0) throw new Error("xarray-ts: slice step cannot be zero");
  const clamp = (i: number, lo: number, hi: number) => Math.min(Math.max(i, lo), hi);
  const norm = (i: number) => (i < 0 ? i + size : i);

  let start: number;
  let stop: number;
  if (step > 0) {
    start = s.start == null ? 0 : clamp(norm(s.start), 0, size);
    stop = s.stop == null ? size : clamp(norm(s.stop), 0, size);
  } else {
    start = s.start == null ? size - 1 : clamp(norm(s.start), -1, size - 1);
    stop = s.stop == null ? -1 : clamp(norm(s.stop), -1, size - 1);
  }
  const length = Math.max(0, Math.ceil((stop - start) / step));
  return { start, stop, step, length };
}

/** Coerce a label to a comparable value: time labels (Date/ISO/ms) become epoch ms. */
function labelToValue(label: Label, coord: Coord): number | bigint | string | boolean {
  if (coord.isTime) {
    if (label instanceof Date) return label.getTime();
    if (typeof label === "string") {
      const ms = Date.parse(label);
      if (Number.isNaN(ms)) throw new Error(`xarray-ts: cannot parse time label "${label}"`);
      return ms;
    }
    return Number(label);
  }
  if (label instanceof Date) {
    throw new Error(
      `xarray-ts: a Date label is only valid on a time coordinate (got "${coord.name}").`,
    );
  }
  return label;
}

/** Numeric distance for `nearest`; throws for non-numeric coordinates. */
function asNumber(v: number | bigint | string | boolean, coordName: string): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  throw new Error(
    `xarray-ts: method "nearest" requires a numeric or time coordinate (got "${coordName}").`,
  );
}

/** Resolve a scalar label to a positional index along a coordinate. */
export function lookupLabel(coord: Coord, label: Label, opts: SelOptions = {}): number {
  const target = labelToValue(label, coord);
  const { values } = coord;
  const exact = values.indexOf(target);
  if (exact !== -1) return exact;
  if ((opts.method ?? "exact") !== "nearest") {
    throw new Error(
      `xarray-ts: label ${JSON.stringify(label)} not found on coordinate "${coord.name}" ` +
        `(pass { method: "nearest" } to snap to the closest value).`,
    );
  }
  const t = asNumber(target, coord.name);
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === undefined) continue;
    const dist = Math.abs(asNumber(v, coord.name) - t);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  if (best === -1) throw new Error(`xarray-ts: coordinate "${coord.name}" is empty`);
  return best;
}

/**
 * Resolve a label range to a positional zarr slice (endpoints inclusive,
 * mirroring xarray). Assumes the coordinate is monotonically increasing.
 */
export function lookupLabelSlice(coord: Coord, ls: LabelSlice): zarr.Slice {
  const values = coord.values.map((v) => asNumber(v, coord.name));
  let start: number | null = null;
  let stop: number | null = null;
  if (ls.start !== undefined) {
    const lo = asNumber(labelToValue(ls.start, coord), coord.name);
    const i = values.findIndex((v) => v >= lo);
    start = i === -1 ? values.length : i;
  }
  if (ls.stop !== undefined) {
    const hi = asNumber(labelToValue(ls.stop, coord), coord.name);
    let i = values.length - 1;
    while (i >= 0 && (values[i] as number) > hi) i--;
    stop = i + 1; // inclusive upper bound -> exclusive stop
  }
  return { start, stop, step: null };
}
