"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { RAINBOWKIT_ENABLED } from "@/lib/config";
import { shortAddr } from "@/lib/domain";
import { DEMO_CONNECTOR_TYPE } from "@/lib/demoConnector";
import { DemoAccountSwitcher } from "./DemoAccountSwitcher";

const LINKS = [
  { href: "/", label: "Browse offers" },
  { href: "/insurer", label: "Insurer" },
  { href: "/policies", label: "My policies" },
  { href: "/oracle", label: "Oracle" },
];

/** Without a WalletConnect project id, a browser (injected) wallet can still connect. */
function InjectedButton() {
  const { address, connector } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  if (connector?.type === DEMO_CONNECTOR_TYPE) return null;
  if (address)
    return (
      <button className="secondary" onClick={() => disconnect()}>
        {shortAddr(address)} · Disconnect
      </button>
    );
  const injected = connectors.find((c) => c.type === "injected");
  if (!injected) return null;
  return (
    <button className="secondary" onClick={() => connect({ connector: injected })}>
      Connect browser wallet
    </button>
  );
}

export function Nav() {
  const path = usePathname();
  return (
    <header className="nav">
      <span className="brand">✈ Flight Delay Insurance</span>
      <nav>
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className={path === l.href ? "active" : ""}>
            {l.label}
          </Link>
        ))}
      </nav>
      <DemoAccountSwitcher />
      {RAINBOWKIT_ENABLED ? <ConnectButton chainStatus="icon" showBalance={false} /> : <InjectedButton />}
    </header>
  );
}
