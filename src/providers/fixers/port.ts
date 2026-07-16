import type { Finding } from "../../domain/evidence/types.js";
import type { ProposedEdit } from "../../domain/fixes/types.js";

/**
 * A fixer proposes a narrow, deterministic remediation for a single finding of
 * one defect class. Fixers are PURE (no IO, no clock): they transform the
 * offending region into a safe replacement.
 *
 * Returning `null` is a first-class outcome: "I cannot produce a safe fix for
 * this." The nightly gate then downgrades the finding from propose_fix to report
 * rather than opening an empty PR — we never claim a fix we did not generate.
 */
export interface Fixer {
  readonly defectClass: string;
  propose(finding: Finding): ProposedEdit | null;
}
