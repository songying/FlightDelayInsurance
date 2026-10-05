"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, useBlock, useChainId, useReadContract, useReadContracts } from "wagmi";
import { fdiAbi } from "@/lib/abi";
import { FDI_ADDRESSES } from "@/lib/config";
import type { Offer, Policy } from "@/lib/domain";

const POLL_MS = 4_000;

export function useFdiAddress() {
  const chainId = useChainId();
  return FDI_ADDRESSES[chainId];
}

/**
 * Chain time in seconds. Uses the latest block timestamp (so Anvil time warps are respected)
 * and ticks locally between blocks so countdowns move smoothly.
 */
export function useChainNow(): bigint {
  const { data: block } = useBlock({ watch: true });
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  const [anchor, setAnchor] = useState<{ chain: bigint; local: number } | null>(null);
  useEffect(() => {
    if (block) setAnchor({ chain: block.timestamp, local: Date.now() });
  }, [block]);
  if (!anchor) return BigInt(Math.floor(tick / 1000));
  return anchor.chain + BigInt(Math.max(0, Math.floor((tick - anchor.local) / 1000)));
}

/** All offers, read via one multicall. Fine for testnet scale. */
export function useOffers() {
  const address = useFdiAddress();
  const count = useReadContract({
    address,
    abi: fdiAbi,
    functionName: "offerCount",
    query: { enabled: !!address, refetchInterval: POLL_MS },
  });
  const n = Number(count.data ?? 0n);
  const offers = useReadContracts({
    contracts: Array.from({ length: n }, (_, i) => ({
      address,
      abi: fdiAbi,
      functionName: "getOffer" as const,
      args: [BigInt(i)] as const,
    })),
    query: { enabled: !!address && n > 0, refetchInterval: POLL_MS },
  });
  const data = useMemo<Offer[]>(
    () =>
      (offers.data ?? []).flatMap((r, i) =>
        r.status === "success" ? [{ ...(r.result as Omit<Offer, "id">), id: BigInt(i) } as Offer] : [],
      ),
    [offers.data],
  );
  const refetch = () => {
    count.refetch();
    offers.refetch();
  };
  return { offers: data, isLoading: count.isLoading || offers.isLoading, error: count.error ?? offers.error, refetch };
}

/** The connected wallet's policy on each offer (premium 0 = none). */
export function useMyPolicies(offers: Offer[]) {
  const address = useFdiAddress();
  const { address: account } = useAccount();
  const res = useReadContracts({
    contracts: offers.map((o) => ({
      address,
      abi: fdiAbi,
      functionName: "getPolicy" as const,
      args: [o.id, account!] as const,
    })),
    query: { enabled: !!address && !!account && offers.length > 0, refetchInterval: POLL_MS },
  });
  const byOffer = useMemo(() => {
    const m = new Map<bigint, Policy>();
    (res.data ?? []).forEach((r, i) => {
      if (r.status === "success" && offers[i]) m.set(offers[i].id, r.result as Policy);
    });
    return m;
  }, [res.data, offers]);
  return { byOffer, refetch: res.refetch };
}

export function useCredit() {
  const address = useFdiAddress();
  const { address: account } = useAccount();
  return useReadContract({
    address,
    abi: fdiAbi,
    functionName: "credit",
    args: [account!],
    query: { enabled: !!address && !!account, refetchInterval: POLL_MS },
  });
}
