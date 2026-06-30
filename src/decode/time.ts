/**
 * Minimal CF time-axis decoding.
 *
 * Decodes coordinates whose `units` follow the CF convention
 * `"<unit> since <reference date>"` (e.g. `"days since 2000-01-01"`) into epoch
 * milliseconds. Only the calendars that coincide with JS `Date` (the proleptic
 * Gregorian calendar — `standard`, `gregorian`, `proleptic_gregorian`) are
 * decoded; non-standard calendars (`noleap`, `360_day`, ...) are left raw and
 * flagged, rather than silently producing wrong dates.
 *
 * @module
 */
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
  /** Whether decoding succeeded (recognised units + standard calendar). */
  decoded: boolean;
}

/**
 * Decode raw time-coordinate values to epoch milliseconds.
 *
 * Returns `decoded: false` (and passes values through as numbers) when the
 * units are unrecognised or the calendar is non-standard.
 */
export function decodeTime(raw: ReadonlyArray<number | bigint>, attrs: Attrs): DecodedTime {
  const calendar =
    typeof attrs["calendar"] === "string" ? attrs["calendar"].toLowerCase() : "standard";
  const units = typeof attrs["units"] === "string" ? attrs["units"] : "";
  const parsed = parseTimeUnits(units);
  if (!parsed || !STANDARD_CALENDARS.has(calendar)) {
    return { values: raw.map(Number), decoded: false };
  }
  const { unitMs, referenceMs } = parsed;
  return {
    values: raw.map((v) => referenceMs + Number(v) * unitMs),
    decoded: true,
  };
}
