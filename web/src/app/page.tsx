"use client";

import { useMemo, useState } from "react";
import { formatEther, parseEther } from "viem";
import { useAccount } from "wagmi";
import { PhaseBadge } from "@/components/Badges";
import { Guard } from "@/components/Guard";
import { OfferFacts } from "@/components/OfferFacts";
import { TxButton } from "@/components/TxButton";
import { useDemoMode } from "@/hooks/useDemoMode";
import { useChainNow, useMyPolicies, useOffers } from "@/hooks/useFdi";
import { checkPremium, maxPremium, phaseOf, utcDate, type Offer, type Policy } from "@/lib/domain";

export default function BrowsePage() {
  return (
    <>
      <h1>Browse offers</h1>
      <Guard needAccount={false}>
        <OfferList />
      </Guard>
    </>
  );
}

function OfferList() {
  const now = useChainNow();
  const { offers, isLoading, error, refetch } = useOffers();
  const { byOffer, refetch: refetchPolicies } = useMyPolicies(offers);
  const [flight, setFlight] = useState("");
  const [date, setDate] = useState("");
  const [showAll, setShowAll] = useState(false);

  const shown = useMemo(
    () =>
      offers
        .filter((o) => !flight || o.flightNumber.includes(flight.trim().toUpperCase()))
        .filter((o) => !date || utcDate(o.scheduledDeparture) === date)
        .filter((o) => showAll || phaseOf(o, now) === "Open")
        .sort((a, b) => Number(a.scheduledDeparture - b.scheduledDeparture)),
    [offers, flight, date, showAll, now],
  );

  if (error) return <p className="err">{error.message}</p>;
  return (
    <>
      <div className="filters">
        <input placeholder="Flight number, e.g. SQ8385" value={flight} onChange={(e) => setFlight(e.target.value)} />
        <label className="row">
          Departure date (UTC)
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="row">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          Include closed and settled
        </label>
      </div>
      {isLoading && <p className="muted">Loading…</p>}
      {!isLoading && shown.length === 0 && <p className="muted">No matching offers.</p>}
      <div className="grid">
        {shown.map((o) => (
          <OfferCard
            key={o.id.toString()}
            o={o}
            now={now}
            policy={byOffer.get(o.id)}
            onDone={() => {
              refetch();
              refetchPolicies();
            }}
          />
        ))}
      </div>
    </>
  );
}

function OfferCard({ o, now, policy, onDone }: { o: Offer; now: bigint; policy?: Policy; onDone: () => void }) {
  const phase = phaseOf(o, now);
  // Demo mode keeps the buy form after sales end, so the class sees the contract's revert.
  const demo = useDemoMode();
  return (
    <div className="card">
      <h3>
        <span>
          {o.flightNumber} <span className="muted">#{o.id.toString()}</span>
        </span>
        <PhaseBadge phase={phase} />
      </h3>
      <OfferFacts o={o} now={now} />
      {(phase === "Open" || (demo && phase === "SalesEnded")) && (
        <BuyForm o={o} now={now} policy={policy} onDone={onDone} sendClosed={demo} />
      )}
      {phase === "Expirable" && (
        <div className="row">
          <TxButton className="secondary" call={{ functionName: "expire", args: [o.id] }} onDone={onDone}>
            Expire (oracle missed deadline)
          </TxButton>
        </div>
      )}
    </div>
  );
}

function BuyForm({
  o,
  now,
  policy,
  onDone,
  sendClosed = false,
}: {
  o: Offer;
  now: bigint;
  policy?: Policy;
  onDone: () => void;
  sendClosed?: boolean;
}) {
  const { address } = useAccount();
  const [input, setInput] = useState("");
  if (!address) return <p className="hint">Connect a wallet to buy.</p>;
  // AC42: hidden for the insurer and oracle wallets.
  const me = address.toLowerCase();
  if (me === o.insurer.toLowerCase() || me === o.oracle.toLowerCase()) {
    return <p className="hint">You are this offer’s {me === o.insurer.toLowerCase() ? "insurer" : "oracle"}.</p>;
  }
  if (policy && policy.premium > 0n) {
    return <p className="hint">You hold a policy: payout {formatEther(policy.payout)} ETH.</p>;
  }

  let premium = 0n;
  try {
    premium = input ? parseEther(input) : 0n;
  } catch {
    premium = -1n;
  }
  const check = premium >= 0n ? checkPremium(o, premium, now) : null;
  const max = maxPremium(o, now);
  const closed = phaseOf(o, now) !== "Open";
  // In demo mode a closed offer still sends, and the contract's revert reason is shown.
  const canSend = !!check?.ok || (sendClosed && closed && premium > 0n);

  return (
    <div>
      <div className="row">
        <input
          className="small"
          placeholder="Premium (ETH)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          inputMode="decimal"
        />
        <button className="secondary" type="button" onClick={() => setInput(formatEther(max))} disabled={max === 0n}>
          Max
        </button>
        <TxButton
          call={{ functionName: "buyPolicy", args: [o.id], value: premium > 0n ? premium : 0n }}
          disabled={!canSend}
          onDone={() => {
            setInput("");
            onDone();
          }}
        >
          Buy
        </TxButton>
      </div>
      <p className="hint">
        {premium < 0n
          ? "Invalid amount"
          : check && premium > 0n
            ? check.ok
              ? `Payout if delayed > 30 min, cancelled or diverted: ${formatEther(check.payout)} ETH`
              : sendClosed && closed
                ? `${check.reason}. Demo: Buy still sends, to show the contract's revert.`
                : check.reason
            : `Up to ${formatEther(max)} ETH`}
      </p>
    </div>
  );
}
