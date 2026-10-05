"use client";

import { useEffect, useState, type ReactNode } from "react";
import { BaseError, ContractFunctionRevertedError, type ContractFunctionName } from "viem";
import { useAccount, usePublicClient, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { fdiAbi } from "@/lib/abi";
import { useFdiAddress } from "@/hooks/useFdi";

type Write = Parameters<ReturnType<typeof useWriteContract>["writeContract"]>[0];
type Call = {
  functionName: ContractFunctionName<typeof fdiAbi, "nonpayable" | "payable">;
  args?: readonly unknown[];
  value?: bigint;
};

/** Prefer the contract's custom error name (e.g. "SalesCutoffPassed") over a generic message. */
export function errorText(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName) return revert.data.errorName;
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}

export function TxButton({
  call,
  disabled,
  children,
  onDone,
  className,
}: {
  call: Call;
  disabled?: boolean;
  children: ReactNode;
  onDone?: () => void;
  className?: string;
}) {
  const address = useFdiAddress();
  const client = usePublicClient();
  const { address: account } = useAccount();
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const [simulating, setSimulating] = useState(false);
  const [simError, setSimError] = useState<unknown>(null);
  const receipt = useWaitForTransactionReceipt({ hash });

  useEffect(() => {
    if (receipt.isSuccess) {
      onDone?.();
      const t = setTimeout(reset, 3_000);
      return () => clearTimeout(t);
    }
  }, [receipt.isSuccess]); // eslint-disable-line react-hooks/exhaustive-deps

  // Simulate first so a revert shows the contract's error name and no transaction is sent.
  const send = async () => {
    reset();
    setSimError(null);
    const req = { ...call, address: address!, abi: fdiAbi };
    setSimulating(true);
    try {
      await client!.simulateContract({ ...req, account } as Parameters<NonNullable<typeof client>["simulateContract"]>[0]);
    } catch (e) {
      setSimError(e);
      return;
    } finally {
      setSimulating(false);
    }
    writeContract(req as unknown as Write);
  };

  const busy = simulating || isPending || receipt.isLoading;
  const err = simError ?? error ?? receipt.error;
  return (
    <span className="tx">
      <button
        className={className}
        disabled={disabled || busy || !address || !client}
        onClick={send}
      >
        {busy ? "Pending…" : children}
      </button>
      {receipt.isSuccess && <span className="ok">✓ confirmed</span>}
      {err != null && <span className="err">{errorText(err)}</span>}
    </span>
  );
}
