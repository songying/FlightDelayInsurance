import type { FlightObservation } from "./flightData.js";

export const REPORT_WINDOW = 172_800; // 48h
export const ALERT_AFTER = 47 * 3600; // AC48

export enum FlightStatus {
  Departed = 0,
  Cancelled = 1,
  Diverted = 2,
}

export type OfferView = {
  id: bigint;
  oracle: string;
  flightNumber: string;
  scheduledDeparture: number;
  settled: boolean;
};

export type Decision =
  | { action: "skip"; reason: string }
  | { action: "wait"; reason: string }
  | { action: "alert"; reason: string }
  | { action: "report"; status: FlightStatus; delayMinutes: number };

/** Whole minutes, floored, never negative. */
export const delayMinutes = (actual: number, scheduled: number) => Math.floor(Math.max(0, actual - scheduled) / 60);

/** Should this bot look up the flight at all right now? (AC47, AC49) */
export function inWindow(o: OfferView, botAddress: string, now: number): Exclude<Decision, { action: "report" }> | null {
  if (o.oracle.toLowerCase() !== botAddress.toLowerCase()) return { action: "skip", reason: "not our offer" };
  if (o.settled) return { action: "skip", reason: "already settled" };
  if (now < o.scheduledDeparture) return { action: "wait", reason: "report window not open" };
  if (now > o.scheduledDeparture + REPORT_WINDOW) return { action: "skip", reason: "report window closed" };
  return null;
}

/** Turns an observation into a report, or waits / alerts. Never reports a guess (AC48). */
export function decide(o: OfferView, obs: FlightObservation, now: number): Decision {
  switch (obs.kind) {
    case "cancelled":
      return { action: "report", status: FlightStatus.Cancelled, delayMinutes: 0 };
    case "diverted":
      return {
        action: "report",
        status: FlightStatus.Diverted,
        delayMinutes: obs.actualDeparture === undefined ? 0 : delayMinutes(obs.actualDeparture, o.scheduledDeparture),
      };
    case "departed":
      return { action: "report", status: FlightStatus.Departed, delayMinutes: delayMinutes(obs.actualDeparture, o.scheduledDeparture) };
    case "unknown":
      if (now >= o.scheduledDeparture + ALERT_AFTER) {
        return { action: "alert", reason: `no departure data ${Math.floor((now - o.scheduledDeparture) / 3600)}h after schedule (${obs.detail ?? "unknown"}); not reporting a guess` };
      }
      return { action: "wait", reason: obs.detail ?? "no data yet" };
  }
}
