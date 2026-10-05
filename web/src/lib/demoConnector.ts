import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ChainNotConfiguredError, createConnector } from "wagmi";
import { foundry } from "wagmi/chains";
import { DEMO_CHAIN_ID, type DemoAccount } from "./demo";

export const DEMO_CONNECTOR_TYPE = "demo";
export const demoConnectorId = (a: Pick<DemoAccount, "index">) => `demo-${a.index}`;

/**
 * A wagmi connector that signs locally with one Anvil account through a viem local account,
 * so the classroom demo needs no browser wallet or WalletConnect. Local chain only.
 */
export function demoConnector(a: DemoAccount, rpcUrl: string) {
  const account = privateKeyToAccount(a.privateKey);
  const transport = http(rpcUrl);
  const id = demoConnectorId(a);
  return createConnector((config) => ({
    id,
    name: `Demo: ${a.label}`,
    type: DEMO_CONNECTOR_TYPE,
    async connect({ chainId } = {}) {
      if (chainId !== undefined && chainId !== DEMO_CHAIN_ID) throw new ChainNotConfiguredError();
      // Cast: wagmi types the result by the withCapabilities generic, which this connector ignores.
      return { accounts: [account.address], chainId: DEMO_CHAIN_ID } as never;
    },
    async disconnect() {},
    async getAccounts() {
      return [account.address];
    },
    async getChainId() {
      return DEMO_CHAIN_ID;
    },
    async getProvider() {
      return createPublicClient({ chain: foundry, transport });
    },
    async getClient() {
      return createWalletClient({ account, chain: foundry, transport });
    },
    async isAuthorized() {
      // Reconnect after a reload only the demo account that was selected last.
      return (await config.storage?.getItem("recentConnectorId")) === id;
    },
    async switchChain({ chainId }) {
      if (chainId !== DEMO_CHAIN_ID) throw new ChainNotConfiguredError();
      return foundry;
    },
    onAccountsChanged() {},
    onChainChanged() {},
    onDisconnect() {
      config.emitter.emit("disconnect");
    },
  }));
}
