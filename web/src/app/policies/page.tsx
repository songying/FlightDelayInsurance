"use client";

import { useMemo } from "react";
import { formatEther } from "viem";
import { StatusBadge } from "@/components/Badges";
import { Guard } from "@/components/Guard";
import { TxButton } from "@/components/TxButton";
import { useChainNow, useMyPolicies, useOffers } from "@/hooks/useFdi";
import {
  Outcome,
  claimDeadline,
  formatCountdown,
  formatUtc,
  policyStatus,
  reportDeadline,
  type Offer,
  type Policy,
} from "@/lib/domain";

export default function PoliciesPage() {
  return (
    <>
      <h1>My policies</h1>
      <Guard>
        <PolicyTable />
      </Guard>
    </>
  );
}

function PolicyTable() {
  const now = useChainNow();
  const { offers, refetch } = useOffers();
  const { byOffer, refetch: refetchPolicies } = useMyPolicies(offers);
  const rows = useMemo(
    () =>
      offers
        .map((o) => ({ o, p: byOffer.get(o.id) }))
        .filter((r): r is { o: Offer; p: Policy } => !!r.p && r.p.premium > 0n)
        .sort((a, b) => Number(b.o.scheduledDeparture - a.o.scheduledDeparture)),
    [offers, byOffer],
  );
  if (rows.length === 0) return <p className="muted">You have no policies yet.</p>;

  const onDone = () => {
    refetch();
    refetchPolicies();
  };
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Flight</th>
            <th>Departure</th>
            <th>Premium</th>
            <th>Payout if delayed</th>
            <th>Status</th>
            <th>Claim deadline</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ o, p }) => {
            const status = policyStatus(o, p, now);
            const claimable = status === "Won" || status === "Refundable";
            return (
              <tr key={o.id.toString()}>
                <td>
                  {o.flightNumber} <span className="muted">#{o.id.toString()}</span>
                </td>
                <td>{formatUtc(o.scheduledDeparture)}</td>
                <td>{formatEther(p.premium)} ETH</td>
                <td>{formatEther(p.payout)} ETH</td>
                <td>
                  <StatusBadge status={status} />
                </td>
                <td>{deadlineText(o, status, now)}</td>
                <td>
                  {claimable && (
                    <TxButton call={{ functionName: "claim", args: [o.id] }} onDone={onDone}>
                      {status === "Won" ? `Claim ${formatEther(p.payout)} ETH` : `Refund ${formatEther(p.premium)} ETH`}
                    </TxButton>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function deadlineText(o: Offer, status: string, now: bigint) {
  if (status !== "Won" && status !== "Refundable") return "—";
  // Not yet expired on-chain: the 90-day window starts when the claim triggers expiry.
  if (o.outcome === Outcome.None) return `90 days after expiry (oracle missed ${formatUtc(reportDeadline(o))})`;
  return `in ${formatCountdown(claimDeadline(o) - now)}`;
}
