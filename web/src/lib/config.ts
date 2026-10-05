import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import { injectedWallet, metaMaskWallet, walletConnectWallet } from "@rainbow-me/rainbowkit/wallets";
import { http } from "viem";
import { createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import { foundry, sepolia } from "wagmi/chains";
import { demoAccounts } from "./demo";
import { demoConnector } from "./demoConnector";

export const LOCAL_RPC_URL = "http://127.0.0.1:8545";

// AC50: contract address per chain comes from config (env), not code.
export const FDI_ADDRESSES: Record<number, `0x${string}` | undefined> = {
  [foundry.id]: (process.env.NEXT_PUBLIC_FDI_ADDRESS_31337 || undefined) as `0x${string}` | undefined,
  [sepolia.id]: (process.env.NEXT_PUBLIC_FDI_ADDRESS_11155111 || undefined) as `0x${string}` | undefined,
};

// Classroom demo accounts (Anvil #0, #1, #2). Keys come from web/.env.local only.
// Next.js inlines NEXT_PUBLIC_* only when each variable is spelled out literally.
export const DEMO_ACCOUNTS = demoAccounts({
  NEXT_PUBLIC_DEMO_INSURER_PK: process.env.NEXT_PUBLIC_DEMO_INSURER_PK,
  NEXT_PUBLIC_DEMO_ALICE_PK: process.env.NEXT_PUBLIC_DEMO_ALICE_PK,
  NEXT_PUBLIC_DEMO_ORACLE_PK: process.env.NEXT_PUBLIC_DEMO_ORACLE_PK,
});

const wcProjectId = process.env.NEXT_PUBLIC_WC_PROJECT_ID || undefined;

/** RainbowKit's connect modal is offered when a WalletConnect project id is configured. */
export const RAINBOWKIT_ENABLED = !!wcProjectId;

const walletConnectors = wcProjectId
  ? connectorsForWallets([{ groupName: "Wallets", wallets: [injectedWallet, metaMaskWallet, walletConnectWallet] }], {
      appName: "Flight Delay Insurance",
      projectId: wcProjectId,
    })
  : [injected()];

export const wagmiConfig = createConfig({
  chains: [foundry, sepolia],
  connectors: [...DEMO_ACCOUNTS.map((a) => demoConnector(a, LOCAL_RPC_URL)), ...walletConnectors],
  transports: {
    [foundry.id]: http(LOCAL_RPC_URL),
    [sepolia.id]: http(process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || undefined),
  },
  ssr: true,
});
