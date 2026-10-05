"use client";

import { useMemo, useState } from "react";
import { formatEther, isAddress, parseEther } from "viem";
import { useAccount } from "wagmi";
import { PhaseBadge } from "@/components/Badges";
import { Guard } from "@/components/Guard";
import { TxButton } from "@/components/TxButton";
import { useChainNow, useCredit, useOffers } from "@/hooks/useFdi";
import {
  MAX_ODDS_BPS,
  MIN_ODDS_BPS,
  Outcome,
  SALES_CUTOFF,
  canSweep,
  claimDeadline,
  formatCountdown,
  formatOdds,
  formatUtc,
  freeCollateral,
  isValidFlightNumber,
  parseOdds,
  phaseOf,
  unclaimed,
  zonedLocalToUtcSeconds,
  type Offer,
} from "@/lib/domain";

export default function InsurerPage() {
  return (
    <>
      <h1>Insurer dashboard</h1>
      <Guard>
        <InsurerDashboard />
      </Guard>
    </>
  );
}

function InsurerDashboard() {
  const { address } = useAccount();
  const now = useChainNow();
  const { offers, refetch } = useOffers();
  const credit = useCredit();
  const mine = useMemo(
    () => offers.filter((o) => o.insurer.toLowerCase() === address?.toLowerCase()).reverse(),
    [offers, address],
  );

  return (
    <>
      {credit.data !== undefined && credit.data > 0n && (
        <div className="card">
          <strong>Credit balance: {formatEther(credit.data)} ETH</strong>
          <p className="hint">A settlement push to your address failed, so the amount was credited instead.</p>
          <TxButton call={{ functionName: "withdrawCredit" }} onDone={() => credit.refetch()}>
            Withdraw credit
          </TxButton>
        </div>
      )}
      <h2>Create offer</h2>
      <CreateOfferForm now={now} onDone={refetch} />
      <h2>My offers</h2>
      {mine.length === 0 && <p className="muted">You have not created any offers.</p>}
      <div className="grid">
        {mine.map((o) => (
          <InsurerOfferCard key={o.id.toString()} o={o} now={now} onDone={refetch} />
        ))}
      </div>
    </>
  );
}

const TIME_ZONES: string[] =
  typeof Intl !== "undefined" && "supportedValuesOf" in Intl ? Intl.supportedValuesOf("timeZone") : ["UTC"];

function CreateOfferForm({ now, onDone }: { now: bigint; onDone: () => void }) {
  const [flight, setFlight] = useState("");
  const [local, setLocal] = useState("");
  const [tz, setTz] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [odds, setOdds] = useState("5.00");
  const [cap, setCap] = useState("");
  const [oracle, setOracle] = useState("");
  const [deposit, setDeposit] = useState("0");

  const dep = zonedLocalToUtcSeconds(local, tz);
  const oddsBps = parseOdds(odds);
  const capWei = safeParseEther(cap);
  const depositWei = safeParseEther(deposit);

  const errors: string[] = [];
  if (flight && !isValidFlightNumber(flight)) errors.push("Flight number must look like SQ8385 (IATA format).");
  if (dep !== null && dep - SALES_CUTOFF <= now) errors.push("Departure must be more than 12 hours from now.");
  if (odds && (oddsBps === null || oddsBps < MIN_ODDS_BPS || oddsBps > MAX_ODDS_BPS))
    errors.push("Odds must be above 1.00× and at most 100.00× (two decimals).");
  if (cap && (capWei === null || capWei === 0n)) errors.push("Cap must be a positive ETH amount.");
  if (oracle && !isAddress(oracle)) errors.push("Oracle must be a valid address.");
  if (depositWei === null) errors.push("Initial deposit must be an ETH amount (0 allowed).");

  const complete = flight && dep !== null && oddsBps !== null && capWei && isAddress(oracle) && depositWei !== null;
  const valid = complete && errors.length === 0;

  return (
    <form className="stack card" onSubmit={(e) => e.preventDefault()}>
      <label>
        Flight number
        <input value={flight} onChange={(e) => setFlight(e.target.value.toUpperCase())} placeholder="SQ8385" />
      </label>
      <div className="row">
        <label>
          Scheduled departure (airport local time)
          <input type="datetime-local" value={local} onChange={(e) => setLocal(e.target.value)} />
        </label>
        <label>
          Airport time zone
          <select value={tz} onChange={(e) => setTz(e.target.value)}>
            {TIME_ZONES.map((z) => (
              <option key={z}>{z}</option>
            ))}
          </select>
        </label>
      </div>
      {dep !== null && <span className="hint">= {formatUtc(dep)}</span>}
      <label>
        Payout odds (×)
        <input value={odds} onChange={(e) => setOdds(e.target.value)} inputMode="decimal" />
        <span className="hint">Payout = premium × odds. {oddsBps ? `(${oddsBps} bps)` : ""}</span>
      </label>
      <label>
        Business-class full fare cap (ETH)
        <input value={cap} onChange={(e) => setCap(e.target.value)} inputMode="decimal" placeholder="1.0" />
        <span className="hint">Maximum payout per policy. Buyers will see this value; it is not verified.</span>
      </label>
      <label>
        Oracle address
        <input value={oracle} onChange={(e) => setOracle(e.target.value.trim())} placeholder="0x…" />
        <span className="hint">The only address allowed to report this flight’s outcome. Its report is final.</span>
      </label>
      <label>
        Initial collateral (ETH)
        <input value={deposit} onChange={(e) => setDeposit(e.target.value)} inputMode="decimal" />
      </label>
      {errors.map((e) => (
        <span key={e} className="err">
          {e}
        </span>
      ))}
      <TxButton
        disabled={!valid}
        call={{
          functionName: "createOffer",
          args: [flight, dep ?? 0n, oddsBps ?? 0, capWei ?? 0n, oracle as `0x${string}`],
          value: depositWei ?? 0n,
        }}
        onDone={onDone}
      >
        Create offer
      </TxButton>
    </form>
  );
}

function InsurerOfferCard({ o, now, onDone }: { o: Offer; now: bigint; onDone: () => void }) {
  const phase = phaseOf(o, now);
  const [amount, setAmount] = useState("");
  const wei = safeParseEther(amount);
  const unsettled = o.outcome === Outcome.None;
  const free = freeCollateral(o);

  return (
    <div className="card">
      <h3>
        <span>
          {o.flightNumber} <span className="muted">#{o.id.toString()}</span>
        </span>
        <PhaseBadge phase={phase} />
      </h3>
      <dl className="kv">
        <dt>Departure (UTC)</dt>
        <dd>{formatUtc(o.scheduledDeparture)}</dd>
        <dt>Odds / cap</dt>
        <dd>
          {formatOdds(o.oddsBps)} / {formatEther(o.capWei)} ETH
        </dd>
        <dt>Collateral</dt>
        <dd>{formatEther(o.collateral)} ETH</dd>
        <dt>Reserved</dt>
        <dd>{formatEther(o.reserved)} ETH</dd>
        <dt>Free</dt>
        <dd>{formatEther(free)} ETH</dd>
        <dt>Premiums</dt>
        <dd>{formatEther(o.premiums)} ETH</dd>
        <dt>Policies</dt>
        <dd>{o.policyCount.toString()}</dd>
        <dt>Outcome</dt>
        <dd>{outcomeText(o)}</dd>
        {!unsettled && (
          <>
            <dt>Unclaimed by holders</dt>
            <dd>{formatEther(unclaimed(o))} ETH</dd>
            <dt>Sweep</dt>
            <dd>
              {o.swept
                ? "done"
                : now > claimDeadline(o)
                  ? "available"
                  : `in ${formatCountdown(claimDeadline(o) - now + 1n)}`}
            </dd>
          </>
        )}
      </dl>
      {unsettled && (
        <>
          <div className="row">
            <input
              className="small"
              placeholder="Amount (ETH)"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
            />
            <TxButton
              disabled={!wei}
              call={{ functionName: "deposit", args: [o.id], value: wei ?? 0n }}
              onDone={() => {
                setAmount("");
                onDone();
              }}
            >
              Deposit
            </TxButton>
            <TxButton
              className="secondary"
              disabled={!wei || wei > free}
              call={{ functionName: "withdrawCollateral", args: [o.id, wei ?? 0n] }}
              onDone={() => {
                setAmount("");
                onDone();
              }}
            >
              Withdraw
            </TxButton>
          </div>
          <div className="row">
            <TxButton className="secondary" disabled={o.salesClosed} call={{ functionName: "closeSales", args: [o.id] }} onDone={onDone}>
              {o.salesClosed ? "Sales closed" : "Close sales (irreversible)"}
            </TxButton>
          </div>
        </>
      )}
      {!unsettled && !o.swept && (
        <div className="row">
          <TxButton disabled={!canSweep(o, now)} call={{ functionName: "sweep", args: [o.id] }} onDone={onDone}>
            Sweep unclaimed
          </TxButton>
        </div>
      )}
    </div>
  );
}

function outcomeText(o: Offer) {
  switch (o.outcome) {
    case Outcome.None:
      return "pending";
    case Outcome.Payout:
      return `payout (${["departed", "cancelled", "diverted"][o.reportedStatus]}, ${o.reportedDelayMinutes} min)`;
    case Outcome.NoPayout:
      return `no payout (${o.reportedDelayMinutes} min)`;
    case Outcome.Expired:
      return "expired: oracle missed deadline";
  }
}

function safeParseEther(s: string): bigint | null {
  if (!s.trim()) return null;
  try {
    const v = parseEther(s.trim());
    return v >= 0n ? v : null;
  } catch {
    return null;
  }
}
