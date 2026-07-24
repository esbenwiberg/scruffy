/**
 * Hostile-execution runner port (ADR-0003 §"Isolated hostile-execution runner").
 *
 * A runner executes commands CONTROLLED BY THE REVIEWED REPOSITORY — the code
 * under review is the adversary. The port therefore promises only negative
 * capabilities: a job gets a fresh disposable environment, bounded resources,
 * read-only input, a bounded scratch area, and NOTHING else — no credentials,
 * no network, no other job's filesystem, no host state. Everything a job emits
 * (exit code, stdout, stderr) is hostile output: bounded here, and never parsed
 * as trusted data by callers.
 *
 * The poison gate never uses this — it must stay independent of arbitrary
 * repository execution time. This serves visual QA and future execution-based
 * analysis gates.
 */

export interface RunnerLimits {
  /** Wall-clock cap for the whole job. */
  timeoutMs: number;
  memoryMb: number;
  cpus: number;
  /** Max processes — a fork bomb dies here, not at the host. */
  pids: number;
  /** Size cap of the writable scratch tmpfs. */
  scratchMb: number;
  /** Per-stream byte cap on captured stdout/stderr. */
  outputBytes: number;
}

export const DEFAULT_LIMITS: RunnerLimits = {
  timeoutMs: 30_000,
  memoryMb: 256,
  cpus: 1,
  pids: 64,
  scratchMb: 64,
  outputBytes: 256 * 1024,
};

export interface RunnerJob {
  /** Job id, [a-z0-9-]{1,64} — also names the disposable environment. */
  id: string;
  /** argv executed inside the sandbox. Repository-controlled: hostile. */
  command: string[];
  /** Input files served READ-ONLY at /job/<path>. Immutable from inside. */
  files?: Record<string, string>;
  limits?: Partial<RunnerLimits>;
}

export interface RunnerResult {
  /**
   * completed — the command ran to its own exit (exitCode is its code);
   * timeout — the wall clock expired and the environment was destroyed;
   * infra_failure — the RUNNER could not execute the job (never the job's
   * fault; callers must treat it like any other infrastructure fault: abstain,
   * never fabricate a verdict from it).
   */
  outcome: "completed" | "timeout" | "infra_failure";
  exitCode: number | null;
  /** Hostile output, truncated at limits.outputBytes. */
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
}

export interface HostileRunner {
  run(job: RunnerJob): Promise<RunnerResult>;
}

export const JOB_ID_PATTERN = /^[a-z0-9-]{1,64}$/;
