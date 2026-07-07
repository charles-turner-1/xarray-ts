/**
 * CF time-axis decoding.
 *
 * Decodes coordinates whose `units` follow the CF convention
 * `"<unit> since <reference date>"` (e.g. `"days since 2000-01-01"`).
 *
 * Two decodings run side by side, following the *primitives-plus-sidecar* model:
 *
 * - **epoch milliseconds** ({@link DecodedTime.values} with `decoded: true`) for
 *   the calendars that coincide with JS `Date` (the proleptic Gregorian
 *   calendar — `standard`, `gregorian`, `proleptic_gregorian`). Non-standard
 *   calendars (`noleap`, `360_day`, ...) keep their raw encoded numbers and are
 *   flagged `decoded: false`, rather than silently producing wrong `Date`s.
 * - **calendar-aware datetimes** ({@link DecodedTime.cftimes}) via `cftime-ts`
 *   for *every* CF calendar it recognises (all nine, including the non-standard
 *   ones). This is the sidecar that lets consumers work with, e.g., a `360_day`
 *   axis; `values` stays primitive.
 *
 * @module
 */
import { num2date, type CFDatetime, type InputCalendar } from "cftime-ts";
import type { Attrs } from "../types.js";

/** Milliseconds per supported CF time unit. */
const UNIT_MS: Record<string, number> = {
  week: 7 * 86_400_000,
  weeks: 7 * 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  hour: 3_600_000,
  hours: 3_600_000,
  hr: 3_600_000,
  minute: 60_000,
  minutes: 60_000,
  min: 60_000,
  second: 1_000,
  seconds: 1_000,
  sec: 1_000,
  s: 1_000,
  millisecond: 1,
  milliseconds: 1,
  msec: 1,
  ms: 1,
};

/** Sub-millisecond units, kept separate since they scale below 1ms. */
const SUBMS_MS: Record<string, number> = {
  microsecond: 1e-3,
  microseconds: 1e-3,
  us: 1e-3,
  nanosecond: 1e-6,
  nanoseconds: 1e-6,
  ns: 1e-6,
};

/** Calendars whose date arithmetic matches JS `Date` (proleptic Gregorian). */
const STANDARD_CALENDARS = new Set(["standard", "gregorian", "proleptic_gregorian"]);

/** Parsed `"<unit> since <reference>"` units string. */
export interface TimeUnits {
  /** Milliseconds represented by one unit step. */
  unitMs: number;
  /** Reference epoch in milliseconds. */
  referenceMs: number;
}

/** Whether an attributes bag describes a CF time axis we recognise. */
export function isTimeUnits(attrs: Attrs): boolean {
  return typeof attrs["units"] === "string" && / since /i.test(attrs["units"]);
}

/** Parse `"<unit> since <reference date>"`; returns `undefined` if unrecognised. */
export function parseTimeUnits(units: string): TimeUnits | undefined {
  const match = /^\s*(\w+)\s+since\s+(.+?)\s*$/i.exec(units);
  if (!match) return undefined;
  const [, rawUnit = "", rawRef = ""] = match;
  const unit = rawUnit.toLowerCase();
  const unitMs = UNIT_MS[unit] ?? SUBMS_MS[unit];
  if (unitMs === undefined) return undefined;
  const referenceMs = parseReference(rawRef);
  if (referenceMs === undefined) return undefined;
  return { unitMs, referenceMs };
}

/** Parse a CF reference date such as `2000-01-01`, `2000-1-1 0:0:0`, or an ISO string. */
function parseReference(ref: string): number | undefined {
  // Normalise "YYYY-MM-DD hh:mm:ss" to ISO; treat naked dates/times as UTC.
  const native = Date.parse(ref);
  if (!Number.isNaN(native)) return native;
  const m =
    /^(\d{1,4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?)?/.exec(
      ref.trim(),
    );
  if (!m) return undefined;
  const [, y = "0", mo = "1", d = "1", hh = "0", mm = "0", ss = "0"] = m;
  return Date.UTC(+y, +mo - 1, +d, +hh, +mm, Math.floor(+ss), Math.round((+ss % 1) * 1000));
}

/** Result of decoding a time coordinate's raw values. */
export interface DecodedTime {
  /** Epoch-millisecond values when `decoded`, otherwise the raw input as numbers. */
  values: number[];
  /** Whether epoch-ms/`Date` decoding succeeded (recognised units + standard calendar). */
  decoded: boolean;
  /** Resolved CF calendar name (lower-cased; defaults to `"standard"`). */
  calendar: string;
  /**
   * Calendar-aware datetimes decoded via `cftime-ts` for *any* CF calendar it
   * recognises (all nine). `undefined` when the units/calendar are unrecognised
   * — e.g. `"weeks since ..."`, which our epoch-ms path supports but `cftime-ts`
   * does not. Non-finite raw values decode to `null` within the array.
   */
  cftimes?: (CFDatetime | null)[];
}

/**
 * Decode raw time-coordinate values.
 *
 * Produces epoch-millisecond {@link DecodedTime.values} (with `decoded: true`)
 * for standard calendars; other calendars keep raw numeric values and
 * `decoded: false`. In parallel, {@link DecodedTime.cftimes} carries calendar-
 * aware `cftime-ts` datetimes for every recognised CF calendar (the sidecar used
 * by `Coord.cftimes()`).
 */
export function decodeTime(raw: ReadonlyArray<number | bigint>, attrs: Attrs): DecodedTime {
  const calendar =
    typeof attrs["calendar"] === "string" ? attrs["calendar"].toLowerCase() : "standard";
  const units = typeof attrs["units"] === "string" ? attrs["units"] : "";

  // Calendar-aware sidecar via cftime-ts, for every calendar it understands.
  // `num2date` throws on unrecognised units/calendars (e.g. "weeks since ...");
  // treat that as "no cftime decoding available" rather than a hard failure.
  let cftimes: (CFDatetime | null)[] | undefined;
  try {
    cftimes = num2date(raw.map(Number), units, { calendar: calendar as InputCalendar });
  } catch {
    cftimes = undefined;
  }

  const parsed = parseTimeUnits(units);
  if (!parsed || !STANDARD_CALENDARS.has(calendar)) {
    return { values: raw.map(Number), decoded: false, calendar, cftimes };
  }
  const { unitMs, referenceMs } = parsed;
  return {
    values: raw.map((v) => referenceMs + Number(v) * unitMs),
    decoded: true,
    calendar,
    cftimes,
  };
}
