"use client";

import { useChainId } from "wagmi";
import { DEMO_ACCOUNTS } from "@/lib/config";
import { demoModeEnabled } from "@/lib/demo";

/** True only on the local Anvil chain (31337) with demo keys configured. */
export function useDemoMode() {
  return demoModeEnabled(useChainId(), DEMO_ACCOUNTS);
}
