import { describe, expect, it } from "vitest";
import { ALERT_AFTER, FlightStatus, decide, delayMinutes, inWindow, type OfferView } from "./decide.js";

const DEP = 1_800_000_000;
const BOT = "0x00000000000000000000000000000000000000Bb";
const offer = (over: Partial<OfferView> = {}): OfferView => ({
  id: 0n,
  oracle: BOT.toLowerCase(),
  flightNumber: "SQ8385",
  scheduledDeparture: DEP,
  settled: false,
  ...over,
});

describe("delayMinutes", () => {
  it("floors to whole minutes and never goes negative", () => {
    expect(delayMinutes(DEP + 30 * 60 + 59, DEP)).toBe(30);
    expect(delayMinutes(DEP + 31 * 60, DEP)).toBe(31);
    expect(delayMinutes(DEP - 600, DEP)).toBe(0);
  });
});

describe("inWindow (AC47, AC49)", () => {
  it("only proceeds for our unsettled offers inside [dep, dep + 48h]", () => {
    expect(inWindow(offer({ oracle: "0x1" }), BOT, DEP)).toMatchObject({ action: "skip" });
    expect(inWindow(offer({ settled: true }), BOT, DEP)).toMatchObject({ action: "skip", reason: "already settled" });
    expect(inWindow(offer(), BOT, DEP - 1)).toMatchObject({ action: "wait" });
    expect(inWindow(offer(), BOT, DEP)).toBeNull();
    expect(inWindow(offer(), BOT, DEP + 172_800)).toBeNull();
    expect(inWindow(offer(), BOT, DEP + 172_801)).toMatchObject({ action: "skip" });
  });
});

describe("decide (AC47, AC48)", () => {
  it("reports departures with floored delay", () => {
    expect(decide(offer(), { kind: "departed", actualDeparture: DEP + 45 * 60 + 10 }, DEP + 3600)).toEqual({
      action: "report",
      status: FlightStatus.Departed,
      delayMinutes: 45,
    });
  });
  it("reports cancellations and diversions", () => {
    expect(decide(offer(), { kind: "cancelled" }, DEP)).toMatchObject({ status: FlightStatus.Cancelled });
    expect(decide(offer(), { kind: "diverted", actualDeparture: DEP + 120 }, DEP)).toMatchObject({
      status: FlightStatus.Diverted,
      delayMinutes: 2,
    });
  });
  it("waits on unknown data, then alerts at +47h without reporting a guess", () => {
    expect(decide(offer(), { kind: "unknown" }, DEP + ALERT_AFTER - 1)).toMatchObject({ action: "wait" });
    expect(decide(offer(), { kind: "unknown" }, DEP + ALERT_AFTER)).toMatchObject({ action: "alert" });
  });
});
