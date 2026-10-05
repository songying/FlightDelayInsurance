"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Browse offers" },
  { href: "/insurer", label: "Insurer" },
  { href: "/policies", label: "My policies" },
  { href: "/oracle", label: "Oracle" },
];

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
      <ConnectButton chainStatus="icon" showBalance={false} />
    </header>
  );
}
