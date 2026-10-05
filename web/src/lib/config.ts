import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http } from "viem";
import { foundry, sepolia } from "wagmi/chains";

// AC50: contract address per chain comes from config (env), not code.
export const FDI_ADDRESSES: Record<number, `0x${string}` | undefined> = {
  [foundry.id]: (process.env.NEXT_PUBLIC_FDI_ADDRESS_31337 || undefined) as `0x${string}` | undefined,
  [sepolia.id]: (process.env.NEXT_PUBLIC_FDI_ADDRESS_11155111 || undefined) as `0x${string}` | undefined,
};

export const wagmiConfig = getDefaultConfig({
  appName: "Flight Delay Insurance",
  // Injected wallets work without a real id; WalletConnect needs one.
  projectId: process.env.NEXT_PUBLIC_WC_PROJECT_ID || "flight-delay-insurance-dev",
  chains: [foundry, sepolia],
  transports: {
    [foundry.id]: http("http://127.0.0.1:8545"),
    [sepolia.id]: http(process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || undefined),
  },
  ssr: true,
});
