import type { FlightDataProvider, FlightObservation } from "./flightData.js";

// AeroDataBox via RapidAPI: GET /flights/number/{number}/{dateLocal}
// https://rapidapi.com/aedbx-aedbx/api/aerodatabox
const HOST = "aerodatabox.p.rapidapi.com";

type AdbTime = { utc?: string; local?: string };
export type AdbFlight = {
  number?: string;
  status?: string;
  departure?: { scheduledTime?: AdbTime; revisedTime?: AdbTime; runwayTime?: AdbTime };
};

/** Statuses after which the aircraft has left the gate. */
const DEPARTED = new Set(["Departed", "EnRoute", "Approaching", "Arrived"]);
const CANCELLED = new Set(["Canceled", "Cancelled"]);
/** Only accept a flight whose scheduled time is within this distance of the offer's. */
const MATCH_TOLERANCE_SECONDS = 6 * 3600;

/** Parses AeroDataBox UTC strings such as "2026-10-05 00:30Z". */
export function parseAdbUtc(s: string | undefined): number | null {
  if (!s) return null;
  const ms = Date.parse(s.trim().replace(" ", "T"));
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** Picks the flight whose scheduled departure is closest to the offer's (within tolerance). */
export function matchFlight(flights: AdbFlight[], scheduledDeparture: number): AdbFlight | null {
  let best: AdbFlight | null = null;
  let bestDiff = Infinity;
  for (const f of flights) {
    const sched = parseAdbUtc(f.departure?.scheduledTime?.utc);
    if (sched === null) continue;
    const diff = Math.abs(sched - scheduledDeparture);
    if (diff <= MATCH_TOLERANCE_SECONDS && diff < bestDiff) {
      best = f;
      bestDiff = diff;
    }
  }
  return best;
}

/**
 * Maps an AeroDataBox flight to an observation. Actual departure is the revised gate time
 * once the flight has departed; runway (take-off) time is the fallback.
 */
export function toObservation(f: AdbFlight | null): FlightObservation {
  if (!f) return { kind: "unknown", detail: "no matching flight" };
  const status = f.status ?? "Unknown";
  const actual = parseAdbUtc(f.departure?.revisedTime?.utc) ?? parseAdbUtc(f.departure?.runwayTime?.utc);
  if (CANCELLED.has(status)) return { kind: "cancelled" };
  if (status === "Diverted") return actual === null ? { kind: "diverted" } : { kind: "diverted", actualDeparture: actual };
  if (DEPARTED.has(status)) {
    return actual === null ? { kind: "unknown", detail: `status ${status} without a departure time` } : { kind: "departed", actualDeparture: actual };
  }
  return { kind: "unknown", detail: `status ${status}` };
}

const isoDate = (secs: number) => new Date(secs * 1000).toISOString().slice(0, 10);

export class AeroDataBoxProvider implements FlightDataProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async lookup(flightNumber: string, scheduledDeparture: number): Promise<FlightObservation> {
    // The API keys on the airport-local date, which can differ from the UTC date by a day.
    const dates = [...new Set([-86_400, 0, 86_400].map((d) => isoDate(scheduledDeparture + d)))];
    const flights: AdbFlight[] = [];
    for (const date of dates) flights.push(...(await this.fetchDate(flightNumber, date)));
    return toObservation(matchFlight(flights, scheduledDeparture));
  }

  private async fetchDate(flightNumber: string, date: string): Promise<AdbFlight[]> {
    const url = `https://${HOST}/flights/number/${encodeURIComponent(flightNumber)}/${date}?dateLocalRole=Departure&withAircraftImage=false&withLocation=false`;
    const res = await this.fetchImpl(url, { headers: { "X-RapidAPI-Key": this.apiKey, "X-RapidAPI-Host": HOST } });
    if (res.status === 204 || res.status === 404) return [];
    if (!res.ok) throw new Error(`AeroDataBox ${res.status} for ${flightNumber} ${date}: ${await res.text()}`);
    const body = (await res.json()) as unknown;
    return Array.isArray(body) ? (body as AdbFlight[]) : [];
  }
}
