import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  DEMO_CHAIN_ID,
  DEMO_KEY_VARS,
  ONE_HOUR,
  demoAccounts,
  demoClock,
  DEMO_DEFAULT_FLIGHT,
  demoModeEnabled,
  demoOfferDefaults,
  secondsUntil,
  withDemoDefaults,
} from "./demo";

// Keys are generated per run: no private key is written into this repository.
const k0 = generatePrivateKey();
const k1 = generatePrivateKey();
const k2 = generatePrivateKey();
const env = {
  [DEMO_KEY_VARS.insurer]: k0,
  [DEMO_KEY_VARS.alice]: k1,
  [DEMO_KEY_VARS.oracle]: k2,
};

describe("demo account table", () => {
  it("lists Anvil #0 insurer, #1 Alice, #2 oracle in that order", () => {
    const accounts = demoAccounts(env);
    expect(accounts.map((a) => [a.index, a.role, a.label])).toEqual([
      [0, "insurer", "Insurer (#0)"],
      [1, "alice", "Alice (#1)"],
      [2, "oracle", "Oracle (#2)"],
    ]);
  });

  it("derives each address from its private key", () => {
    const accounts = demoAccounts(env);
    expect(accounts.map((a) => a.address)).toEqual([k0, k1, k2].map((k) => privateKeyToAccount(k).address));
    expect(accounts.map((a) => a.privateKey)).toEqual([k0, k1, k2]);
  });

  it("reads the keys from NEXT_PUBLIC_DEMO_* variables", () => {
    expect(DEMO_KEY_VARS).toEqual({
      insurer: "NEXT_PUBLIC_DEMO_INSURER_PK",
      alice: "NEXT_PUBLIC_DEMO_ALICE_PK",
      oracle: "NEXT_PUBLIC_DEMO_ORACLE_PK",
    });
  });

  it("is empty when no keys are configured", () => {
    expect(demoAccounts({})).toEqual([]);
    expect(demoAccounts({ [DEMO_KEY_VARS.insurer]: "", [DEMO_KEY_VARS.alice]: "  " })).toEqual([]);
  });

  it("skips a role whose key is missing", () => {
    const accounts = demoAccounts({ [DEMO_KEY_VARS.insurer]: k0, [DEMO_KEY_VARS.oracle]: k2 });
    expect(accounts.map((a) => a.role)).toEqual(["insurer", "oracle"]);
  });

  it("accepts a key without the 0x prefix", () => {
    const [a] = demoAccounts({ [DEMO_KEY_VARS.alice]: k1.slice(2) });
    expect(a.address).toBe(privateKeyToAccount(k1).address);
  });

  it("rejects a malformed key and names the variable, not the value", () => {
    expect(() => demoAccounts({ [DEMO_KEY_VARS.alice]: "0x1234" })).toThrow(/NEXT_PUBLIC_DEMO_ALICE_PK/);
    expect(() => demoAccounts({ [DEMO_KEY_VARS.alice]: "0x1234" })).not.toThrow(/0x1234/);
  });

  it("no private key is hard-coded in web/src", () => {
    const src = fileURLToPath(new URL("..", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name)) files.push(p);
      }
    };
    walk(src);
    const offenders = files.filter((f) => /0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("demo clock", () => {
  const DEP = 1_800_000_000n;
  const CUTOFF = DEP - 43_200n;
  const DEADLINE = DEP + 172_800n;

  it("computes the sales cutoff, scheduled departure and report deadline", () => {
    const c = demoClock({ scheduledDeparture: DEP }, CUTOFF - 1000n);
    expect(c.cutoff).toBe(CUTOFF);
    expect(c.departure).toBe(DEP);
    expect(c.reportDeadline).toBe(DEADLINE);
  });

  it("gives the seconds to advance to cutoff + 1 s, departure + 1 h and deadline + 1 s", () => {
    const now = CUTOFF - 1000n;
    const c = demoClock({ scheduledDeparture: DEP }, now);
    expect(c.advance.oneHour).toBe(3600n);
    expect(c.advance.toCutoff).toBe(1001n);
    expect(c.advance.toDeparture).toBe(DEP + 3600n - now);
    expect(c.advance.toDeadline).toBe(DEADLINE + 1n - now);
  });

  it("lands exactly one second past the cutoff, where buyPolicy must revert (SPEC B6)", () => {
    const now = 1_700_000_000n;
    const c = demoClock({ scheduledDeparture: DEP }, now);
    expect(now + c.advance.toCutoff).toBe(CUTOFF + 1n);
    expect(now + c.advance.toDeparture).toBe(DEP + ONE_HOUR);
    expect(now + c.advance.toDeadline).toBe(DEADLINE + 1n);
  });

  it("never goes backwards: a target already reached needs 0 s", () => {
    const c = demoClock({ scheduledDeparture: DEP }, DEP + 7200n);
    expect(c.advance.toCutoff).toBe(0n);
    expect(c.advance.toDeparture).toBe(0n);
    expect(c.advance.toDeadline).toBe(DEADLINE + 1n - (DEP + 7200n));
    expect(c.advance.oneHour).toBe(3600n);
  });

  it("secondsUntil is 0 at and after the target", () => {
    expect(secondsUntil(100n, 40n)).toBe(60n);
    expect(secondsUntil(100n, 100n)).toBe(0n);
    expect(secondsUntil(100n, 150n)).toBe(0n);
  });
});

describe("demo mode guard", () => {
  const accounts = demoAccounts(env);

  it("is the Anvil chain id", () => {
    expect(DEMO_CHAIN_ID).toBe(31337);
  });

  it("is on only for chain 31337 with demo accounts configured", () => {
    expect(demoModeEnabled(31337, accounts)).toBe(true);
  });

  it("is off on any other chain", () => {
    expect(demoModeEnabled(1, accounts)).toBe(false);
    expect(demoModeEnabled(11155111, accounts)).toBe(false);
    expect(demoModeEnabled(undefined, accounts)).toBe(false);
  });

  it("is off when no demo keys are configured", () => {
    expect(demoModeEnabled(31337, [])).toBe(false);
  });
});

describe("demo offer defaults", () => {
  it("defaults the flight to SQ8385 and the oracle to Anvil #2", () => {
    const d = demoOfferDefaults(demoAccounts(env));
    expect(DEMO_DEFAULT_FLIGHT).toBe("SQ8385");
    expect(d).toEqual({ flightNumber: "SQ8385", oracle: privateKeyToAccount(k2).address });
  });

  it("has no oracle default when the oracle key is not configured", () => {
    expect(demoOfferDefaults(demoAccounts({ [DEMO_KEY_VARS.insurer]: k0 }))).toEqual({ flightNumber: "SQ8385" });
  });

  it("fills only blank fields", () => {
    const d = demoOfferDefaults(demoAccounts(env));
    expect(withDemoDefaults({ flightNumber: "", oracle: "  " }, d)).toEqual(d);
    const typed = { flightNumber: "SQ8386", oracle: privateKeyToAccount(k1).address };
    expect(withDemoDefaults(typed, d)).toEqual(typed);
  });

  it("changes nothing outside demo mode", () => {
    expect(withDemoDefaults({ flightNumber: "", oracle: "" }, null)).toEqual({ flightNumber: "", oracle: "" });
  });
});
