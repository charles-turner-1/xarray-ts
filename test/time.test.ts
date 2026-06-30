import { describe, expect, it } from "vitest";
import { decodeTime, isTimeUnits, parseTimeUnits } from "../src/decode/time.js";

describe("CF time decoding", () => {
  it("recognises CF time units", () => {
    expect(isTimeUnits({ units: "days since 2000-01-01" })).toBe(true);
    expect(isTimeUnits({ units: "hours since 1970-01-01 00:00:00" })).toBe(true);
    expect(isTimeUnits({ units: "K" })).toBe(false);
    expect(isTimeUnits({})).toBe(false);
  });

  it("parses '<unit> since <reference>'", () => {
    expect(parseTimeUnits("days since 2000-01-01")).toEqual({
      unitMs: 86_400_000,
      referenceMs: Date.UTC(2000, 0, 1),
    });
    expect(parseTimeUnits("seconds since 1970-01-01")).toEqual({
      unitMs: 1_000,
      referenceMs: 0,
    });
    expect(parseTimeUnits("not a time unit")).toBeUndefined();
  });

  it("decodes standard calendars to epoch ms", () => {
    const decoded = decodeTime([0, 1, 2], {
      units: "days since 2000-01-01",
      calendar: "standard",
    });
    expect(decoded.decoded).toBe(true);
    expect(decoded.values).toEqual([
      Date.UTC(2000, 0, 1),
      Date.UTC(2000, 0, 2),
      Date.UTC(2000, 0, 3),
    ]);
  });

  it("leaves non-standard calendars raw and flagged", () => {
    const decoded = decodeTime([0, 1], {
      units: "days since 2000-01-01",
      calendar: "360_day",
    });
    expect(decoded.decoded).toBe(false);
    expect(decoded.values).toEqual([0, 1]);
  });
});
