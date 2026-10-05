"use client";

import { useEffect, type ReactNode } from "react";
import { BaseError, ContractFunctionRevertedError, type ContractFunctionName } from "viem";
import { useWaitForTransactionReceipt, useWriteContract } from "wagmi";
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
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash });

  useEffect(() => {
    if (receipt.isSuccess) {
      onDone?.();
      const t = setTimeout(reset, 3_000);
      return () => clearTimeout(t);
    }
  }, [receipt.isSuccess]); // eslint-disable-line react-hooks/exhaustive-deps

  const busy = isPending || receipt.isLoading;
  return (
    <span className="tx">
      <button
        className={className}
        disabled={disabled || busy || !address}
        onClick={() => writeContract({ ...call, address: address!, abi: fdiAbi } as unknown as Write)}
      >
        {busy ? "Pending…" : children}
      </button>
      {receipt.isSuccess && <span className="ok">✓ confirmed</span>}
      {(error || receipt.error) && <span className="err">{errorText(error ?? receipt.error)}</span>}
    </span>
  );
}
