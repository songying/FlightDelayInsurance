"use client";

import { useAccount, useConnect, useConnectors, useDisconnect } from "wagmi";
import { useDemoMode } from "@/hooks/useDemoMode";
import { DEMO_ACCOUNTS } from "@/lib/config";
import { shortAddr } from "@/lib/domain";
import { DEMO_CONNECTOR_TYPE, demoConnectorId } from "@/lib/demoConnector";
import { errorText } from "./TxButton";

/** Header control that switches the acting Anvil account (#0 insurer, #1 Alice, #2 oracle). */
export function DemoAccountSwitcher() {
  const demo = useDemoMode();
  const connectors = useConnectors();
  const { connector: current } = useAccount();
  const { connect, error } = useConnect();
  const { disconnect } = useDisconnect();
  if (!demo) return null;

  const selected = current?.type === DEMO_CONNECTOR_TYPE ? current.id : "";
  const onChange = (id: string) => {
    if (!id) {
      if (selected) disconnect();
      return;
    }
    const connector = connectors.find((c) => c.id === id);
    if (connector) connect({ connector });
  };

  return (
    <label className="switcher">
      <span className="hint">Demo account</span>
      <select value={selected} onChange={(e) => onChange(e.target.value)}>
        <option value="">— none —</option>
        {DEMO_ACCOUNTS.map((a) => (
          <option key={a.index} value={demoConnectorId(a)}>
            {a.label} {shortAddr(a.address)}
          </option>
        ))}
      </select>
      {error && <span className="err">{errorText(error)}</span>}
    </label>
  );
}
