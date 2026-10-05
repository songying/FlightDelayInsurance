// Pure logic for the classroom demo mode on a local Anvil chain. No React, no I/O.

import { isHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { reportDeadline, salesCutoff, type Offer } from "./domain";

export const DEMO_CHAIN_ID = 31337;
export const ONE_HOUR = 3600n;

export type DemoRole = "insurer" | "alice" | "oracle";

export type DemoAccount = {
  index: number;
  role: DemoRole;
  label: string;
  address: `0x${string}`;
  privateKey: Hex;
};

/** Env variables holding the private keys of Anvil accounts #0, #1 and #2 (set in web/.env.local). */
export const DEMO_KEY_VARS = {
  insurer: "NEXT_PUBLIC_DEMO_INSURER_PK",
  alice: "NEXT_PUBLIC_DEMO_ALICE_PK",
  oracle: "NEXT_PUBLIC_DEMO_ORACLE_PK",
} as const satisfies Record<DemoRole, string>;

const ROLES: { index: number; role: DemoRole; name: string }[] = [
  { index: 0, role: "insurer", name: "Insurer" },
  { index: 1, role: "alice", name: "Alice" },
  { index: 2, role: "oracle", name: "Oracle" },
];

/**
 * The demo account table. A role whose key is unset is left out; a malformed key throws,
 * naming the variable but never echoing its value.
 */
export function demoAccounts(env: Record<string, string | undefined>): DemoAccount[] {
  return ROLES.flatMap(({ index, role, name }) => {
    const raw = env[DEMO_KEY_VARS[role]]?.trim();
    if (!raw) return [];
    const privateKey = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
    if (!isHex(privateKey) || privateKey.length !== 66)
      throw new Error(`${DEMO_KEY_VARS[role]} is not a 32-byte hex private key`);
    const { address } = privateKeyToAccount(privateKey);
    return [{ index, role, label: `${name} (#${index})`, address, privateKey }];
  });
}

/** Demo mode is on only on the local Anvil chain, and only if demo keys are configured. */
export const demoModeEnabled = (chainId: number | undefined, accounts: readonly DemoAccount[]) =>
  chainId === DEMO_CHAIN_ID && accounts.length > 0;

/** Seconds to advance so that chain time reaches `target`; 0 if it already has (time never goes back). */
export const secondsUntil = (target: bigint, now: bigint) => (target > now ? target - now : 0n);

/** An offer's time edges and the evm_increaseTime amounts for the demo panel's buttons. */
export function demoClock(o: Pick<Offer, "scheduledDeparture">, now: bigint) {
  const cutoff = salesCutoff(o);
  const departure = o.scheduledDeparture;
  const deadline = reportDeadline(o);
  return {
    cutoff,
    departure,
    reportDeadline: deadline,
    advance: {
      oneHour: ONE_HOUR,
      toCutoff: secondsUntil(cutoff + 1n, now),
      toDeparture: secondsUntil(departure + ONE_HOUR, now),
      toDeadline: secondsUntil(deadline + 1n, now),
    },
  };
}
