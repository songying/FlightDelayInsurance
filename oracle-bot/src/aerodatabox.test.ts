import { describe, expect, it } from "vitest";
import { AeroDataBoxProvider, matchFlight, parseAdbUtc, toObservation, type AdbFlight } from "./aerodatabox.js";

const DEP = Date.UTC(2026, 9, 5, 0, 30) / 1000; // 2026-10-05 00:30Z

const flight = (status: string, revised?: string, scheduled = "2026-10-05 00:30Z"): AdbFlight => ({
  number: "SQ 8385",
  status,
  departure: { scheduledTime: { utc: scheduled }, ...(revised ? { revisedTime: { utc: revised } } : {}) },
});

describe("parsing", () => {
  it("parses AeroDataBox UTC timestamps", () => {
    expect(parseAdbUtc("2026-10-05 00:30Z")).toBe(DEP);
    expect(parseAdbUtc(undefined)).toBeNull();
    expect(parseAdbUtc("garbage")).toBeNull();
  });

  it("matches the flight instance closest to the offer's scheduled time", () => {
    const yesterday = flight("Arrived", undefined, "2026-10-04 00:30Z");
    const today = flight("Departed", "2026-10-05 01:10Z");
    expect(matchFlight([yesterday, today], DEP)).toBe(today);
    expect(matchFlight([yesterday], DEP)).toBeNull();
  });

  it("maps statuses to observations", () => {
    expect(toObservation(flight("Departed", "2026-10-05 01:10Z"))).toEqual({ kind: "departed", actualDeparture: DEP + 40 * 60 });
    expect(toObservation(flight("Canceled"))).toEqual({ kind: "cancelled" });
    expect(toObservation(flight("Diverted"))).toEqual({ kind: "diverted" });
    expect(toObservation(flight("Expected", "2026-10-05 02:00Z"))).toMatchObject({ kind: "unknown" });
    expect(toObservation(flight("Departed"))).toMatchObject({ kind: "unknown" });
    expect(toObservation(null)).toMatchObject({ kind: "unknown" });
  });
});

describe("AeroDataBoxProvider", () => {
  it("queries adjacent local dates and sends RapidAPI headers", async () => {
    const urls: string[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      urls.push(url);
      expect((init?.headers as Record<string, string>)["X-RapidAPI-Key"]).toBe("k");
      if (url.includes("/2026-10-05?")) return new Response(JSON.stringify([flight("Departed", "2026-10-05 00:59Z")]));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const obs = await new AeroDataBoxProvider("k", fakeFetch).lookup("SQ8385", DEP);
    expect(obs).toEqual({ kind: "departed", actualDeparture: DEP + 29 * 60 });
    expect(urls.map((u) => u.match(/SQ8385\/([\d-]+)/)![1])).toEqual(["2026-10-04", "2026-10-05", "2026-10-06"]);
  });

  it("throws on API errors so the run retries later", async () => {
    const fakeFetch = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    await expect(new AeroDataBoxProvider("k", fakeFetch).lookup("SQ8385", DEP)).rejects.toThrow(/429/);
  });
});
