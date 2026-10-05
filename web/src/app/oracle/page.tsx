"use client";

import { useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { PhaseBadge } from "@/components/Badges";
import { Guard } from "@/components/Guard";
import { TxButton } from "@/components/TxButton";
import { useChainNow, useOffers } from "@/hooks/useFdi";
import {
  FlightStatus,
  Outcome,
  formatCountdown,
  formatUtc,
  isReportWindowOpen,
  outcomeFor,
  phaseOf,
  reportDeadline,
  type Offer,
} from "@/lib/domain";

export default function OraclePage() {
  return (
    <>
      <h1>Oracle console</h1>
      <Guard>
        <OracleOffers />
      </Guard>
    </>
  );
}

function OracleOffers() {
  const { address } = useAccount();
  const now = useChainNow();
  const { offers, refetch } = useOffers();
  const mine = useMemo(
    () =>
      offers
        .filter((o) => o.oracle.toLowerCase() === address?.toLowerCase())
        .sort((a, b) => Number(a.scheduledDeparture - b.scheduledDeparture)),
    [offers, address],
  );
  if (mine.length === 0) return <p className="muted">No offers name this wallet as their oracle.</p>;
  return (
    <div className="grid">
      {mine.map((o) => (
        <ReportCard key={o.id.toString()} o={o} now={now} onDone={refetch} />
      ))}
    </div>
  );
}

const STATUS_LABEL = ["Departed", "Cancelled", "Diverted"];

function ReportCard({ o, now, onDone }: { o: Offer; now: bigint; onDone: () => void }) {
  const [status, setStatus] = useState(FlightStatus.Departed);
  const [mins, setMins] = useState("0");
  const open = isReportWindowOpen(o, now);
  const minutes = /^\d+$/.test(mins) ? Number(mins) : NaN;
  const validMinutes = Number.isInteger(minutes) && minutes >= 0 && minutes <= 4_294_967_295;
  const preview = validMinutes ? outcomeFor(status, minutes) : null;

  return (
    <div className="card">
      <h3>
        <span>
          {o.flightNumber} <span className="muted">#{o.id.toString()}</span>
        </span>
        <PhaseBadge phase={phaseOf(o, now)} />
      </h3>
      <dl className="kv">
        <dt>Scheduled departure</dt>
        <dd>{formatUtc(o.scheduledDeparture)}</dd>
        <dt>Report window</dt>
        <dd>
          {formatUtc(o.scheduledDeparture)} → {formatUtc(reportDeadline(o))}
        </dd>
        <dt>Window</dt>
        <dd>
          {o.outcome !== Outcome.None
            ? "reported / settled"
            : now < o.scheduledDeparture
              ? `opens in ${formatCountdown(o.scheduledDeparture - now)}`
              : open
                ? `closes in ${formatCountdown(reportDeadline(o) - now + 1n)}`
                : "closed (expirable)"}
        </dd>
        <dt>Policies</dt>
        <dd>{o.policyCount.toString()}</dd>
      </dl>
      {open && (
        <>
          <div className="row">
            <select value={status} onChange={(e) => setStatus(Number(e.target.value) as FlightStatus)}>
              {STATUS_LABEL.map((l, i) => (
                <option key={l} value={i}>
                  {l}
                </option>
              ))}
            </select>
            <label className="row">
              Delay (whole minutes)
              <input className="small" value={mins} onChange={(e) => setMins(e.target.value)} inputMode="numeric" />
            </label>
          </div>
          <p className={preview === Outcome.Payout ? "ok" : "hint"}>
            {preview === null
              ? "Enter a non-negative whole number of minutes."
              : preview === Outcome.Payout
                ? "Outcome: PAYOUT. Every policyholder can claim their payout."
                : "Outcome: NO PAYOUT. Insurer keeps premiums and collateral."}
          </p>
          <TxButton
            disabled={preview === null}
            call={{ functionName: "report", args: [o.id, status, validMinutes ? minutes : 0] }}
            onDone={onDone}
          >
            Submit final report
          </TxButton>
        </>
      )}
    </div>
  );
}
