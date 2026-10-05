// Pure domain logic mirroring the contract rules in SPEC.md. No React, no I/O.

export const BPS = 10_000n;
export const SALES_CUTOFF = 43_200n; // 12h
export const REPORT_WINDOW = 172_800n; // 48h
export const CLAIM_WINDOW = 7_776_000n; // 90 days
export const DELAY_THRESHOLD_MINUTES = 30;
export const MIN_ODDS_BPS = 10_001;
export const MAX_ODDS_BPS = 1_000_000;

export enum FlightStatus {
  Departed = 0,
  Cancelled = 1,
  Diverted = 2,
}

export enum Outcome {
  None = 0,
  Payout = 1,
  NoPayout = 2,
  Expired = 3,
}

export type Offer = {
  id: bigint;
  insurer: `0x${string}`;
  oracle: `0x${string}`;
  scheduledDeparture: bigint;
  oddsBps: number;
  salesClosed: boolean;
  swept: boolean;
  outcome: Outcome;
  reportedStatus: FlightStatus;
  reportedDelayMinutes: number;
  settledAt: bigint;
  capWei: bigint;
  collateral: bigint;
  reserved: bigint;
  premiums: bigint;
  totalPayout: bigint;
  claimedAmount: bigint;
  policyCount: bigint;
  flightNumber: string;
};

export type Policy = { premium: bigint; payout: bigint; claimed: boolean };

export type Phase = "Open" | "SalesEnded" | "AwaitingReport" | "Expirable" | "Settled" | "Swept";

export type PolicyStatus = "Active" | "Won" | "Lost" | "Refundable" | "Claimed" | "Refunded" | "Forfeited";

// ------------------------------------------------------------------ time edges

export const salesCutoff = (o: Pick<Offer, "scheduledDeparture">) => o.scheduledDeparture - SALES_CUTOFF;
export const reportDeadline = (o: Pick<Offer, "scheduledDeparture">) => o.scheduledDeparture + REPORT_WINDOW;
export const claimDeadline = (o: Pick<Offer, "settledAt">) => o.settledAt + CLAIM_WINDOW;

export function phaseOf(o: Offer, now: bigint): Phase {
  if (o.outcome !== Outcome.None) return o.swept ? "Swept" : "Settled";
  if (now > reportDeadline(o)) return "Expirable";
  if (now >= o.scheduledDeparture) return "AwaitingReport";
  if (o.salesClosed || now > salesCutoff(o)) return "SalesEnded";
  return "Open";
}

export const isReportWindowOpen = (o: Offer, now: bigint) =>
  o.outcome === Outcome.None && now >= o.scheduledDeparture && now <= reportDeadline(o);

// --------------------------------------------------------------------- money

export const payoutFor = (premium: bigint, oddsBps: number) => (premium * BigInt(oddsBps)) / BPS;

export const freeCollateral = (o: Offer) => (o.outcome === Outcome.None ? o.collateral - o.reserved : 0n);

/** Largest p with floor(p * mul / BPS) <= limit. */
const largestBelow = (limit: bigint, mul: bigint) => ((limit + 1n) * BPS - 1n) / mul;

/** Mirrors FlightDelayInsurance.maxPremium. */
export function maxPremium(o: Offer, now: bigint): bigint {
  if (phaseOf(o, now) !== "Open") return 0n;
  const odds = BigInt(o.oddsBps);
  // SPEC.md section 4 cap bound. BigInt cannot overflow, so the contract's saturation is not needed.
  const byCap = (o.capWei * BPS) / odds;
  const byCollateral = largestBelow(freeCollateral(o), odds - BPS);
  const m = byCap < byCollateral ? byCap : byCollateral;
  // payout > premium needs a reservation of at least 1 wei; below this premium nothing is buyable.
  const minBuyable = (BPS + (odds - BPS) - 1n) / (odds - BPS);
  return m < minBuyable ? 0n : m;
}

export type PremiumCheck = { ok: true; payout: bigint } | { ok: false; reason: string; payout: bigint };

/** Client-side mirror of buyPolicy's checks, for the buy form. */
export function checkPremium(o: Offer, premium: bigint, now: bigint): PremiumCheck {
  const payout = payoutFor(premium, o.oddsBps);
  if (phaseOf(o, now) !== "Open") return { ok: false, reason: "Sales are closed", payout };
  if (premium <= 0n) return { ok: false, reason: "Enter a premium", payout };
  if (payout <= premium) return { ok: false, reason: "Premium too small: payout would not exceed it", payout };
  if (payout > o.capWei) return { ok: false, reason: "Payout would exceed the business-fare cap", payout };
  if (payout - premium > freeCollateral(o)) return { ok: false, reason: "Not enough insurer collateral", payout };
  return { ok: true, payout };
}

export const outcomeFor = (status: FlightStatus, delayMinutes: number) =>
  status !== FlightStatus.Departed || delayMinutes > DELAY_THRESHOLD_MINUTES ? Outcome.Payout : Outcome.NoPayout;

export function policyStatus(o: Offer, p: Policy, now: bigint): PolicyStatus {
  switch (o.outcome) {
    case Outcome.None:
      // After the report deadline a claim triggers implicit expiry and refunds the premium.
      return now > reportDeadline(o) ? "Refundable" : "Active";
    case Outcome.NoPayout:
      return "Lost";
    case Outcome.Payout:
      if (p.claimed) return "Claimed";
      return o.swept || now > claimDeadline(o) ? "Forfeited" : "Won";
    case Outcome.Expired:
      if (p.claimed) return "Refunded";
      return o.swept || now > claimDeadline(o) ? "Forfeited" : "Refundable";
  }
}

export const unclaimed = (o: Offer) => {
  if (o.outcome === Outcome.Payout) return o.totalPayout - o.claimedAmount;
  if (o.outcome === Outcome.Expired) return o.premiums - o.claimedAmount;
  return 0n;
};

export const canSweep = (o: Offer, now: bigint) =>
  o.outcome !== Outcome.None && !o.swept && now > claimDeadline(o) && unclaimed(o) > 0n;

// -------------------------------------------------------------- flight input

export const IATA_FLIGHT_RE = /^[A-Z0-9]{2}[0-9]{1,4}[A-Z]?$/;
export const isValidFlightNumber = (s: string) => IATA_FLIGHT_RE.test(s);

/** "5.00" -> 50000 bps. Returns null if not a number with at most 2 decimals. */
export function parseOdds(s: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(s.trim())) return null;
  const [whole, frac = ""] = s.trim().split(".");
  return Number(whole) * 10_000 + Number(frac.padEnd(2, "0")) * 100;
}

export const formatOdds = (bps: number) => `${(bps / 10_000).toFixed(2)}×`;

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function tzOffsetMs(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - instantMs;
}

/**
 * Converts an airport-local wall-clock time ("YYYY-MM-DDTHH:mm") in an IANA time zone
 * to UTC unix seconds. Returns null on malformed input.
 */
export function zonedLocalToUtcSeconds(local: string, timeZone: string): bigint | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  // Two passes handle DST transitions correctly.
  let guess = wall - tzOffsetMs(wall, timeZone);
  guess = wall - tzOffsetMs(guess, timeZone);
  return BigInt(Math.floor(guess / 1000));
}

// ----------------------------------------------------------------- display

export function formatCountdown(seconds: bigint): string {
  if (seconds <= 0n) return "0s";
  let s = Number(seconds);
  const d = Math.floor(s / 86_400);
  s -= d * 86_400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

export const formatUtc = (secs: bigint) =>
  new Date(Number(secs) * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";

export const formatLocal = (secs: bigint) =>
  new Date(Number(secs) * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZoneName: "short",
  });

export const utcDate = (secs: bigint) => new Date(Number(secs) * 1000).toISOString().slice(0, 10);

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
