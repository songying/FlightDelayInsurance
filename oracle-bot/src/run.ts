import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { fdiAbi } from "./abi.js";
import { AeroDataBoxProvider } from "./aerodatabox.js";
import { FlightStatus, decide, inWindow, type OfferView } from "./decide.js";
import type { FlightDataProvider } from "./flightData.js";

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

export async function runOnce(provider: FlightDataProvider) {
  const account = privateKeyToAccount(env("ORACLE_PRIVATE_KEY") as Hex);
  const transport = http(env("RPC_URL"));
  const pub = createPublicClient({ transport });
  const wallet = createWalletClient({ account, transport });
  const address = env("CONTRACT_ADDRESS") as Address;

  // Use chain time, not wall-clock time, so the window matches what the contract enforces.
  const now = Number((await pub.getBlock()).timestamp);
  const count = await pub.readContract({ address, abi: fdiAbi, functionName: "offerCount" });
  log(`oracle ${account.address}, ${count} offers, chain time ${new Date(now * 1000).toISOString()}`);

  for (let i = 0n; i < count; i++) {
    const raw = await pub.readContract({ address, abi: fdiAbi, functionName: "getOffer", args: [i] });
    const o: OfferView = {
      id: i,
      oracle: raw.oracle,
      flightNumber: raw.flightNumber,
      scheduledDeparture: Number(raw.scheduledDeparture),
      settled: raw.outcome !== 0,
    };
    const gate = inWindow(o, account.address, now);
    if (gate) {
      if (gate.action !== "skip" || gate.reason !== "not our offer") log(`#${i} ${o.flightNumber}: ${gate.action} (${gate.reason})`);
      continue;
    }

    let decision;
    try {
      decision = decide(o, await provider.lookup(o.flightNumber, o.scheduledDeparture), now);
    } catch (e) {
      log(`#${i} ${o.flightNumber}: lookup failed, will retry next run:`, (e as Error).message);
      continue;
    }

    if (decision.action === "alert") {
      console.error(`ALERT #${i} ${o.flightNumber}: ${decision.reason}`);
      continue;
    }
    if (decision.action !== "report") {
      log(`#${i} ${o.flightNumber}: ${decision.action} (${decision.reason})`);
      continue;
    }

    log(`#${i} ${o.flightNumber}: reporting ${FlightStatus[decision.status]}, ${decision.delayMinutes} min`);
    try {
      const hash = await wallet.writeContract({
        address,
        abi: fdiAbi,
        functionName: "report",
        args: [i, decision.status, decision.delayMinutes],
        chain: null,
      });
      const receipt = await pub.waitForTransactionReceipt({ hash });
      log(`#${i} ${o.flightNumber}: ${receipt.status} in tx ${hash}`);
    } catch (e) {
      console.error(`#${i} ${o.flightNumber}: report failed, will retry next run:`, (e as Error).message);
    }
  }
}

async function main() {
  const provider = new AeroDataBoxProvider(env("RAPIDAPI_KEY"));
  if (!process.argv.includes("--loop")) return runOnce(provider);
  const interval = Number(process.env.LOOP_INTERVAL_SECONDS ?? 300) * 1000;
  for (;;) {
    try {
      await runOnce(provider);
    } catch (e) {
      console.error("run failed:", e);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
