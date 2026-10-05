"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { createTestClient, http, numberToHex } from "viem";
import { useBlock, usePublicClient } from "wagmi";
import { foundry } from "wagmi/chains";
import { useOffers } from "@/hooks/useFdi";
import { useDemoMode } from "@/hooks/useDemoMode";
import { LOCAL_RPC_URL } from "@/lib/config";
import { DEMO_CHAIN_ID, demoClock } from "@/lib/demo";
import { formatCountdown, formatUtc, phaseOf } from "@/lib/domain";
import { PhaseBadge } from "./Badges";
import { errorText } from "./TxButton";

const testClient = createTestClient({ mode: "anvil", chain: foundry, transport: http(LOCAL_RPC_URL) });

/** Classroom panel: shows chain time and an offer's time edges, and warps Anvil time. */
export function DemoPanel() {
  const demo = useDemoMode();
  if (!demo) return null;
  return <Panel />;
}

function Panel() {
  const queryClient = useQueryClient();
  const publicClient = usePublicClient({ chainId: DEMO_CHAIN_ID });
  // The latest block's timestamp is what the contract sees as block.timestamp (it never runs ahead).
  const { data: block } = useBlock({ chainId: DEMO_CHAIN_ID, watch: true });
  const { offers } = useOffers();
  const [picked, setPicked] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const offer = useMemo(
    () => offers.find((o) => o.id.toString() === picked) ?? offers[offers.length - 1],
    [offers, picked],
  );
  const now = block?.timestamp;
  const clock = offer && now !== undefined ? demoClock(offer, now) : undefined;

  const advance = async (seconds: bigint, what: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await testClient.request({ method: "evm_increaseTime", params: [numberToHex(seconds)] });
      await testClient.request({ method: "evm_mine", params: undefined });
      const b = await publicClient!.getBlock();
      setMsg({ ok: true, text: `Advanced ${formatCountdown(seconds)} (${what}). Chain time ${formatUtc(b.timestamp)}` });
      await queryClient.invalidateQueries();
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const button = (seconds: bigint | undefined, label: string) => (
    <button className="secondary" disabled={busy || !seconds || !publicClient} onClick={() => advance(seconds!, label)}>
      {label}
    </button>
  );

  return (
    <section className="demo-panel">
      <strong>Demo (Anvil 31337)</strong>
      <dl className="kv">
        <dt>Chain time</dt>
        <dd>{now !== undefined ? formatUtc(now) : "…"}</dd>
        {offer && clock && now !== undefined && (
          <>
            <dt>Offer</dt>
            <dd>
              <select value={offer.id.toString()} onChange={(e) => setPicked(e.target.value)}>
                {offers.map((o) => (
                  <option key={o.id.toString()} value={o.id.toString()}>
                    #{o.id.toString()} {o.flightNumber}
                  </option>
                ))}
              </select>{" "}
              <PhaseBadge phase={phaseOf(offer, now)} />
            </dd>
            <dt>Sales cutoff</dt>
            <dd>{formatUtc(clock.cutoff)}</dd>
            <dt>Departure</dt>
            <dd>{formatUtc(clock.departure)}</dd>
            <dt>Report deadline</dt>
            <dd>{formatUtc(clock.reportDeadline)}</dd>
          </>
        )}
      </dl>
      {!offer && <p className="hint">No offers yet. Create one on the Insurer page to see its cutoff, departure and deadline.</p>}
      <div className="row">
        {button(clock?.advance.oneHour ?? 3600n, "advance 1 hour")}
        {button(clock?.advance.toCutoff, "advance to cutoff + 1 s")}
        {button(clock?.advance.toDeparture, "advance to departure + 1 h")}
        {button(clock?.advance.toDeadline, "advance to deadline + 1 s")}
      </div>
      {msg && <p className={msg.ok ? "ok" : "err"}>{msg.text}</p>}
    </section>
  );
}
