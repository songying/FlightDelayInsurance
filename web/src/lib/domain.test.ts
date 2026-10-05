import { describe, expect, it } from "vitest";
import {
  FlightStatus,
  Outcome,
  checkPremium,
  isValidFlightNumber,
  maxPremium,
  outcomeFor,
  parseOdds,
  phaseOf,
  policyStatus,
  zonedLocalToUtcSeconds,
  type Offer,
} from "./domain";

const ETH = 10n ** 18n;
const DEP = 1_800_000_000n;

const offer = (over: Partial<Offer> = {}): Offer => ({
  id: 0n,
  insurer: "0x0000000000000000000000000000000000000001",
  oracle: "0x0000000000000000000000000000000000000002",
  scheduledDeparture: DEP,
  oddsBps: 50_000,
  salesClosed: false,
  swept: false,
  outcome: Outcome.None,
  reportedStatus: FlightStatus.Departed,
  reportedDelayMinutes: 0,
  settledAt: 0n,
  capWei: ETH,
  collateral: 10n * ETH,
  reserved: 0n,
  premiums: 0n,
  totalPayout: 0n,
  claimedAmount: 0n,
  policyCount: 0n,
  flightNumber: "SQ8385",
  ...over,
});

describe("phaseOf", () => {
  const cutoff = DEP - 43_200n;
  const D = DEP + 172_800n;
  it("tracks every time edge", () => {
    expect(phaseOf(offer(), cutoff)).toBe("Open");
    expect(phaseOf(offer(), cutoff + 1n)).toBe("SalesEnded");
    expect(phaseOf(offer({ salesClosed: true }), cutoff - 100n)).toBe("SalesEnded");
    expect(phaseOf(offer(), DEP - 1n)).toBe("SalesEnded");
    expect(phaseOf(offer(), DEP)).toBe("AwaitingReport");
    expect(phaseOf(offer(), D)).toBe("AwaitingReport");
    expect(phaseOf(offer(), D + 1n)).toBe("Expirable");
    expect(phaseOf(offer({ outcome: Outcome.Payout }), D)).toBe("Settled");
    expect(phaseOf(offer({ outcome: Outcome.Payout, swept: true }), D)).toBe("Swept");
  });
});

describe("maxPremium / checkPremium", () => {
  const now = DEP - 86_400n;
  it("is cap-limited and matches the contract boundary", () => {
    const o = offer();
    expect(maxPremium(o, now)).toBe(ETH / 5n);
    expect(checkPremium(o, ETH / 5n, now).ok).toBe(true);
    expect(checkPremium(o, ETH / 5n + 1n, now)).toMatchObject({ ok: false });
  });
  it("is collateral-limited", () => {
    const o = offer({ collateral: (4n * ETH) / 10n });
    expect(maxPremium(o, now)).toBe(ETH / 10n);
    expect(checkPremium(o, ETH / 10n + 1n, now)).toMatchObject({ ok: false, reason: "Not enough insurer collateral" });
  });
  it("rejects payout not above premium", () => {
    expect(checkPremium(offer({ oddsBps: 10_001 }), 1n, now)).toMatchObject({ ok: false });
  });
  it("is zero when sales are not open", () => {
    expect(maxPremium(offer(), DEP - 43_199n)).toBe(0n);
  });
  // The cases below mirror contracts/test/Review.t.sol (R2, R3) after the PR #9 fixes.
  it("uses the SPEC.md cap bound floor(cap * 10000 / odds)", () => {
    expect(maxPremium(offer({ capWei: 10n, oddsBps: 15_000, collateral: ETH }), now)).toBe(6n);
  });
  it("is zero when no premium is buyable", () => {
    // 1.5x with zero collateral: every purchase needs a reservation of at least 1 wei.
    expect(maxPremium(offer({ oddsBps: 15_000, collateral: 0n }), now)).toBe(0n);
    // A cap of 1 wei at 1.5x: no premium pays more than itself within the cap.
    expect(maxPremium(offer({ capWei: 1n, oddsBps: 15_000 }), now)).toBe(0n);
  });
  it("only ever returns a premium that passes checkPremium", () => {
    let seed = 42;
    const rand = (max: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed % max;
    };
    for (let i = 0; i < 2_000; i++) {
      const o = offer({
        oddsBps: 10_001 + rand(990_000),
        capWei: BigInt(1 + rand(1_000_000)) * 10n ** BigInt(rand(19)),
        collateral: BigInt(rand(1_000_000)) * 10n ** BigInt(rand(19)),
      });
      const m = maxPremium(o, now);
      if (m > 0n) expect(checkPremium(o, m, now), JSON.stringify({ ...o, m }, (_, v) => (typeof v === "bigint" ? `${v}` : v))).toMatchObject({ ok: true });
    }
  });
});

describe("outcomeFor", () => {
  it("applies the strict 30-minute threshold", () => {
    expect(outcomeFor(FlightStatus.Departed, 30)).toBe(Outcome.NoPayout);
    expect(outcomeFor(FlightStatus.Departed, 31)).toBe(Outcome.Payout);
    expect(outcomeFor(FlightStatus.Cancelled, 0)).toBe(Outcome.Payout);
    expect(outcomeFor(FlightStatus.Diverted, 0)).toBe(Outcome.Payout);
  });
});

describe("policyStatus", () => {
  const p = { premium: ETH / 10n, payout: ETH / 2n, claimed: false };
  const S = 1_000n + 7_776_000n;
  it("covers every status", () => {
    expect(policyStatus(offer(), p, DEP)).toBe("Active");
    expect(policyStatus(offer(), p, DEP + 172_801n)).toBe("Refundable");
    expect(policyStatus(offer({ outcome: Outcome.NoPayout }), p, DEP)).toBe("Lost");
    const won = offer({ outcome: Outcome.Payout, settledAt: 1_000n });
    expect(policyStatus(won, p, S)).toBe("Won");
    expect(policyStatus(won, p, S + 1n)).toBe("Forfeited");
    expect(policyStatus(won, { ...p, claimed: true }, S + 1n)).toBe("Claimed");
    const exp = offer({ outcome: Outcome.Expired, settledAt: 1_000n });
    expect(policyStatus(exp, p, S)).toBe("Refundable");
    expect(policyStatus(exp, { ...p, claimed: true }, S)).toBe("Refunded");
    expect(policyStatus({ ...exp, swept: true }, p, S)).toBe("Forfeited");
  });
});

describe("input parsing", () => {
  it("validates IATA flight numbers", () => {
    for (const ok of ["SQ8385", "U21", "9W1234", "BA1234A"]) expect(isValidFlightNumber(ok)).toBe(true);
    for (const bad of ["sq8385", "SQ", "SQ12345", "S-385", "SQ8385AB", ""]) expect(isValidFlightNumber(bad)).toBe(false);
  });
  it("parses odds to bps", () => {
    expect(parseOdds("5")).toBe(50_000);
    expect(parseOdds("1.01")).toBe(10_100);
    expect(parseOdds("2.5")).toBe(25_000);
    expect(parseOdds("1.001")).toBeNull();
    expect(parseOdds("abc")).toBeNull();
  });
  it("converts airport-local time to UTC, including DST", () => {
    // Singapore is UTC+8 year-round.
    expect(zonedLocalToUtcSeconds("2026-12-01T08:30", "Asia/Singapore")).toBe(
      BigInt(Date.UTC(2026, 11, 1, 0, 30) / 1000),
    );
    // London: GMT in January, BST (UTC+1) in July.
    expect(zonedLocalToUtcSeconds("2026-01-15T10:00", "Europe/London")).toBe(BigInt(Date.UTC(2026, 0, 15, 10) / 1000));
    expect(zonedLocalToUtcSeconds("2026-07-15T10:00", "Europe/London")).toBe(BigInt(Date.UTC(2026, 6, 15, 9) / 1000));
    expect(zonedLocalToUtcSeconds("bad", "UTC")).toBeNull();
  });
});
