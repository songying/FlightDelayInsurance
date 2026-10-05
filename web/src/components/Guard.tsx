"use client";

import type { ReactNode } from "react";
import { useAccount } from "wagmi";
import { useFdiAddress } from "@/hooks/useFdi";

/** Renders children only when a wallet is connected to a chain with a configured contract. */
export function Guard({ children, needAccount = true }: { children: ReactNode; needAccount?: boolean }) {
  const { isConnected } = useAccount();
  const address = useFdiAddress();
  if (needAccount && !isConnected) return <p className="muted">Connect a wallet to continue.</p>;
  if (!address)
    return (
      <p className="muted">
        No contract address is configured for this network. Set <code>NEXT_PUBLIC_FDI_ADDRESS_&lt;chainId&gt;</code>.
      </p>
    );
  return <>{children}</>;
}
