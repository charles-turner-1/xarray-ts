/**
 * Codegen: turn an {@link Op} log into xarray Python source.
 *
 * The pipeline mirrors xrexpr's `emit` → render split, so an optimiser could one
 * day sit in front of {@link emit} without touching the renderer:
 *
 * ```
 * Op[]  ──emit──►  Call[]  ──renderPython──►  "ds.isel(time=0).drop_vars(['y'])"
 * ```
 *
 * A {@link Call} is pure codegen output (no IR metadata): the unit the renderer
 * knows how to print. One {@link Op} maps to one {@link Call} today, but the
 * shape (a list) is what lets a future lowering pass expand or fuse.
 *
 * @module
 */
import type { LabelSlice, SelOptions, SliceArg } from "../types.js";
import { assertNever, type Op } from "./ir.js";

/** A pre-rendered Python expression, spliced verbatim by {@link renderArg} (e.g. `slice(1, 3)`). */
export interface PyExpr {
  readonly __py: string;
}

/** Wrap a raw Python expression so {@link renderArg} emits it verbatim. */
export const raw = (py: string): PyExpr => ({ __py: py });

const isPyExpr = (v: unknown): v is PyExpr => typeof v === "object" && v !== null && "__py" in v;

/** One printable call in a chain — the analogue of xrexpr's `Call`. */
export type Call =
  | { readonly type: "open"; readonly source: string; readonly kwargs: Record<string, unknown> }
  | {
      readonly type: "method";
      readonly name: string;
      readonly args: readonly unknown[];
      readonly kwargs: Record<string, unknown>;
    }
  | { readonly type: "getitem"; readonly key: unknown };

/** Options for {@link renderPython}. */
export interface RenderOptions {
  /**
   * Emit the `import xarray as xr` + `<var> = xr.open_dataset(...)` head. When
   * `false`, emit only the transform tail starting from {@link RenderOptions.baseVar}
   * (used to `eval` a chain against an already-open dataset).
   */
  header?: boolean;
  /** Override the `open_dataset` source expression (e.g. a real path for tests). */
  source?: string;
  /** The identifier the headless tail starts from. Defaults to `"ds"`. */
  baseVar?: string;
  /** The variable the header assigns to. Defaults to `"da"` if the chain projects, else `"ds"`. */
  varName?: string;
}

/**
 * Lower an {@link Op} log to a list of printable {@link Call}s.
 *
 * @param ops - the recorded operation log.
 * @returns the calls to print, in order.
 */
export function emit(ops: readonly Op[]): Call[] {
  return ops.map(emitOne);
}

function emitOne(op: Op): Call {
  switch (op.kind) {
    case "open":
      return { type: "open", source: op.source, kwargs: op.kwargs as Record<string, unknown> };
    case "select": {
      const mapped = Object.fromEntries(
        Object.entries(op.selection).map(([dim, v]) => [dim, pyIndexer(v)]),
      );
      const opts = (op.opts ?? {}) as Record<string, unknown>;
      // xarray takes selections as `**kwargs` when the dims are identifiers,
      // else as a positional mapping (`.isel({"weird-dim": 0})`).
      if (Object.keys(mapped).every(isIdentifier)) {
        return { type: "method", name: op.name, args: [], kwargs: { ...mapped, ...opts } };
      }
      return { type: "method", name: op.name, args: [mapped], kwargs: opts };
    }
    case "rename":
      // `name` is already the literal xarray method (see CLAUDE.md); `arg` is the
      // literal argument (a mapping, or a bare string for DataArray `rename("x")`).
      return {
        type: "method",
        name: op.name,
        args: [typeof op.arg === "string" ? op.arg : { ...op.arg }],
        kwargs: {},
      };
    case "drop":
      return { type: "method", name: "drop_vars", args: [[...op.variables]], kwargs: {} };
    case "pick":
      return { type: "getitem", key: [...op.variables] };
    case "set_coords":
      return { type: "method", name: "set_coords", args: [[...op.variables]], kwargs: {} };
    case "reset_coords":
      return {
        type: "method",
        name: "reset_coords",
        args: op.variables ? [[...op.variables]] : [],
        kwargs: op.drop ? { drop: true } : {},
      };
    case "swap_dims":
      return { type: "method", name: "swap_dims", args: [{ ...op.mapping }], kwargs: {} };
    case "squeeze":
      return {
        type: "method",
        name: "squeeze",
        args: op.dim === undefined ? [] : [op.dim],
        kwargs: {},
      };
    case "project":
      return { type: "getitem", key: op.name };
    default:
      return assertNever(op);
  }
}

/**
 * Render a {@link Call} list as xarray Python source.
 *
 * @param calls - the calls, from {@link emit}.
 * @param options - see {@link RenderOptions}.
 * @returns the Python source string.
 */
export function renderPython(calls: readonly Call[], options: RenderOptions = {}): string {
  const openCall = calls.find((c): c is Extract<Call, { type: "open" }> => c.type === "open");
  const tail = calls.filter((c) => c.type !== "open");
  const header = options.header ?? true;
  const projects = calls.some((c) => c.type === "getitem" && !Array.isArray(c.key));
  const baseVar = options.baseVar ?? "ds";

  let expr = header && openCall ? renderOpen(openCall, options.source) : baseVar;
  for (const call of tail) expr += renderSuffix(call);

  if (!header) return expr;
  const varName = options.varName ?? (projects ? "da" : "ds");
  return `import xarray as xr\n${varName} = ${expr}`;
}

function renderOpen(call: Extract<Call, { type: "open" }>, source?: string): string {
  const parts = [source ?? call.source, ...renderKwargs(call.kwargs)];
  return `xr.open_dataset(${parts.join(", ")})`;
}

function renderSuffix(call: Call): string {
  switch (call.type) {
    case "getitem":
      return `[${renderArg(call.key)}]`;
    case "method": {
      const parts = [...call.args.map(renderArg), ...renderKwargs(call.kwargs)];
      return `.${call.name}(${parts.join(", ")})`;
    }
    case "open":
      // Handled by renderOpen; an open in the tail would be a bug.
      throw new Error("xarray-ts: unexpected open call in chain tail.");
  }
}

function renderKwargs(kwargs: Record<string, unknown>): string[] {
  return Object.entries(kwargs).map(([k, v]) => `${k}=${renderArg(v)}`);
}

/**
 * Render one JavaScript value as a Python literal.
 *
 * @param value - the value (a scalar, array, plain object, {@link PyExpr}, or `Date`).
 * @returns the Python source for it.
 */
export function renderArg(value: unknown): string {
  if (isPyExpr(value)) return value.__py;
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(renderArg).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${JSON.stringify(k)}: ${renderArg(v)}`,
    );
    return `{${entries.join(", ")}}`;
  }
  throw new Error(`xarray-ts: cannot render ${typeof value} as a Python literal.`);
}

/** Convert an isel/sel indexer value into something {@link renderArg} prints correctly. */
function pyIndexer(v: unknown): unknown {
  // In indexer position, the only object that is *not* a slice is a Date.
  if (typeof v === "object" && v !== null && !(v instanceof Date) && !Array.isArray(v)) {
    return slicePy(v as SliceArg | LabelSlice);
  }
  return v;
}

function slicePy(s: SliceArg | LabelSlice): PyExpr {
  const start = renderArg((s as SliceArg).start ?? null);
  const stop = renderArg((s as SliceArg).stop ?? null);
  const step = (s as SliceArg).step;
  return raw(step === undefined ? `slice(${start}, ${stop})` : `slice(${start}, ${stop}, ${step})`);
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const isIdentifier = (s: string): boolean => IDENTIFIER.test(s);

// Re-export for callers that build a full script from a Dataset's log.
export type { SelOptions };
