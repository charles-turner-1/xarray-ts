/**
 * Executes an interactive doc cell's TypeScript entirely in the browser.
 *
 * Pipeline: strip TS types with sucrase, wrap the result in an async function
 * whose scope holds every export of the playground bundle (`openDataset`,
 * `makeDemoStore`, …), run it, and capture both `console.*` output and the value
 * of a trailing expression (notebook-style "last line is the result").
 */
import { transform } from "sucrase";

/** A captured `console.*` call. */
export interface LogLine {
  level: "log" | "info" | "warn" | "error";
  text: string;
}

/** The outcome of running a cell. */
export interface RunResult {
  logs: LogLine[];
  /** Formatted value of the trailing expression, if any. */
  result?: string;
  /** Formatted error, if the cell threw. */
  error?: string;
}

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

let modulePromise: Promise<Record<string, unknown>> | undefined;

/**
 * Load the library + fixtures bundle once, from the site's base URL.
 *
 * The bundle lives in `/public`, which Vite forbids importing directly from
 * source in dev ("can only be referenced via HTML tags"). So we fetch its text
 * and import it as a blob URL — this never touches Vite's module resolver and
 * behaves identically in dev and in the production build. The bundle inlines all
 * its dependencies, so it has no external imports to resolve.
 */
function loadPlayground(): Promise<Record<string, unknown>> {
  if (!modulePromise) {
    const base = import.meta.env.BASE_URL.endsWith("/")
      ? import.meta.env.BASE_URL
      : `${import.meta.env.BASE_URL}/`;
    const url = `${base}playground.js`;
    modulePromise = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
        return res.text();
      })
      .then((code) => {
        const blobUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
        return import(/* @vite-ignore */ blobUrl).finally(() => URL.revokeObjectURL(blobUrl));
      })
      .catch((err) => {
        modulePromise = undefined; // allow a later Run to retry
        throw err;
      });
  }
  return modulePromise;
}

/** Warm up the bundle (e.g. on first editor focus) so the first Run is snappy. */
export function preloadPlayground(): void {
  void loadPlayground();
}

/** Run one cell's source and return its captured output. */
export async function runCell(code: string): Promise<RunResult> {
  let mod: Record<string, unknown>;
  try {
    mod = await loadPlayground();
  } catch (err) {
    return {
      logs: [],
      error: `Failed to load the xarray-ts playground bundle.\n${errorText(err)}`,
    };
  }
  return runAgainst(mod, code);
}

/**
 * Run `code` with the given module's exports in scope. Split out from
 * {@link runCell} (which only adds bundle loading) so it can be exercised in a
 * plain Node harness against the built bundle.
 */
export async function runAgainst(mod: Record<string, unknown>, code: string): Promise<RunResult> {
  const logs: LogLine[] = [];
  let js: string;
  try {
    js = transform(code, { transforms: ["typescript"], disableESTransforms: true }).code;
  } catch (err) {
    return { logs, error: `Syntax error.\n${errorText(err)}` };
  }

  const body = injectTrailingReturn(js);
  const names = Object.keys(mod).filter((n) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n));
  const captured = makeConsole(logs);

  let runner: (...args: unknown[]) => Promise<unknown>;
  try {
    runner = new Function(
      ...names,
      "console",
      `"use strict";\nreturn (async () => {\n${body}\n})();`,
    ) as typeof runner;
  } catch (err) {
    return { logs, error: `Syntax error.\n${errorText(err)}` };
  }

  try {
    const value = await runner(...names.map((n) => mod[n]), captured);
    return { logs, result: value === undefined ? undefined : formatValue(value) };
  } catch (err) {
    return { logs, error: errorText(err) };
  }
}

/** A console that records calls instead of writing to the real one. */
function makeConsole(logs: LogLine[]): Console {
  const push =
    (level: LogLine["level"]) =>
    (...args: unknown[]) =>
      logs.push({ level, text: args.map(formatArg).join(" ") });
  return {
    log: push("log"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    debug: push("log"),
  } as unknown as Console;
}

const STATEMENT_KEYWORD =
  /^(const|let|var|function|class|if|else|for|while|do|switch|return|throw|try|catch|finally|import|export|break|continue|await\s+using|using)\b/;

/**
 * If the cell ends in a standalone bare expression (notebook-style "last line is
 * the result"), rewrite it to `return (…)` so its value is displayed.
 *
 * Deliberately conservative: it must never produce invalid syntax, so it bails
 * unless the final line is unambiguously a self-contained expression — no
 * semicolon, no comment, balanced brackets, not an assignment or keyword
 * statement, and not a continuation of a multi-line statement. Anything else
 * just runs, and cells display via `console.log`.
 */
function injectTrailingReturn(js: string): string {
  const lines = js.split("\n");
  const meaningful: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t !== "" && !t.startsWith("//")) meaningful.push(i);
  }
  if (meaningful.length === 0) return js;

  const lastIdx = meaningful[meaningful.length - 1]!;
  const line = lines[lastIdx]!;
  const t = line.trim();

  if (t.includes(";") || t.includes("//")) return js; // not a clean single expression
  if (/[{}]$/.test(t)) return js; // a block, not an expression
  if (STATEMENT_KEYWORD.test(t)) return js;
  if (/^[A-Za-z_$][\w$]*\s*=[^=]/.test(t)) return js; // assignment
  if (!isBalanced(t)) return js;

  // Guard against wrapping the tail of a multi-line statement.
  if (meaningful.length >= 2) {
    const prev = lines[meaningful[meaningful.length - 2]!]!.trim();
    if (!/[;{}]$/.test(prev)) return js;
  }

  const indent = line.slice(0, line.length - line.trimStart().length);
  lines[lastIdx] = `${indent}return (${t});`;
  return lines.join("\n");
}

/** True if brackets/quotes in a single line are balanced (ignores their contents). */
function isBalanced(s: string): boolean {
  const close: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote && s[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") stack.push(c);
    else if (c === ")" || c === "]" || c === "}") if (stack.pop() !== close[c]) return false;
  }
  return stack.length === 0 && quote === null;
}

/** Format a single console argument the way a REPL would. */
function formatArg(value: unknown): string {
  if (typeof value === "string") return value;
  return formatValue(value);
}

/**
 * Format a value for display. `Dataset`/`DataArray`/`Coord` carry the library's
 * own Node-inspect hook, so we reuse it to reproduce the xarray-style repr;
 * everything else falls back to typed-array/date-aware stringification.
 */
export function formatValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";

  const inspector = (value as Record<symbol, unknown>)[INSPECT];
  if (typeof inspector === "function") {
    try {
      return (inspector as InspectHook).call(
        value,
        2,
        { stylize: (s: string) => s, depth: 2 },
        (v: unknown) => plain(v),
      );
    } catch {
      /* fall through */
    }
  }

  if (isTypedArray(value)) {
    const arr = Array.from(value as ArrayLike<number | bigint>, (n) => n.toString());
    const head = arr.slice(0, 24);
    const tail = arr.length > 24 ? ", …" : "";
    return `${(value as object).constructor.name}(${arr.length}) [${head.join(", ")}${tail}]`;
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "object") return plain(value);
  return String(value);
}

type InspectHook = (
  depth: number,
  options: { stylize: (s: string) => string; depth: number },
  inspect: (v: unknown) => string,
) => string;

/** JSON-ish rendering that copes with the values zarr hands back. */
function plain(value: unknown): string {
  const replacer = (_key: string, val: unknown) => {
    if (typeof val === "bigint") return `${val}n`;
    if (isTypedArray(val)) return Array.from(val as ArrayLike<number>);
    if (val instanceof Date) return val.toISOString();
    return val;
  };
  try {
    // Compact when it fits on a line (REPL-like); pretty-print when it doesn't.
    const compact = JSON.stringify(value, replacer);
    if (compact !== undefined && compact.length <= 72) return compact;
    return JSON.stringify(value, replacer, 2);
  } catch {
    return String(value);
  }
}

function isTypedArray(value: unknown): boolean {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return String(err);
}
