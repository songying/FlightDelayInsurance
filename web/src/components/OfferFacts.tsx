import { formatEther } from "viem";
import {
  formatCountdown,
  formatLocal,
  formatOdds,
  formatUtc,
  freeCollateral,
  maxPremium,
  phaseOf,
  salesCutoff,
  shortAddr,
  type Offer,
} from "@/lib/domain";

/** The facts AC41 requires on every offer. */
export function OfferFacts({ o, now }: { o: Offer; now: bigint }) {
  const phase = phaseOf(o, now);
  const cutoff = salesCutoff(o);
  return (
    <dl className="kv">
      <dt>Departure (local)</dt>
      <dd>{formatLocal(o.scheduledDeparture)}</dd>
      <dt>Departure (UTC)</dt>
      <dd>{formatUtc(o.scheduledDeparture)}</dd>
      <dt>Odds</dt>
      <dd>{formatOdds(o.oddsBps)}</dd>
      <dt>Payout cap</dt>
      <dd>{formatEther(o.capWei)} ETH</dd>
      <dt>Max premium now</dt>
      <dd>{formatEther(maxPremium(o, now))} ETH</dd>
      <dt>Free capacity</dt>
      <dd>{formatEther(freeCollateral(o))} ETH</dd>
      <dt>Oracle</dt>
      <dd title={o.oracle}>{shortAddr(o.oracle)}</dd>
      <dt>Sales close</dt>
      <dd>{phase === "Open" ? `in ${formatCountdown(cutoff - now)}` : o.salesClosed ? "closed by insurer" : "closed"}</dd>
      <dt>Policies sold</dt>
      <dd>{o.policyCount.toString()}</dd>
    </dl>
  );
}
