import type { Phase, PolicyStatus } from "@/lib/domain";

export const PhaseBadge = ({ phase }: { phase: Phase }) => <span className={`badge phase-${phase}`}>{phase}</span>;

export const StatusBadge = ({ status }: { status: PolicyStatus }) => (
  <span className={`badge status-${status}`}>{status}</span>
);
