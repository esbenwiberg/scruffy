/**
 * Keep an analysis lease alive while the (possibly slow) work runs. A model call
 * can outlast the lease window; without a heartbeat the reconciler would see the
 * lease expire, reclaim the run, and let another worker re-take it — burning an
 * attempt on a worker that is perfectly healthy, just slow. The heartbeat renews
 * the lease periodically so an ALIVE worker is never mistaken for a crashed one.
 *
 * Fencing still does the safety work: renewal is guarded on the fencing token, so
 * a worker that WAS reclaimed cannot resurrect its lease, and a crashed worker
 * stops renewing (its interval dies with the process) and is correctly reclaimed.
 */

/** The single store method the heartbeat needs. */
export interface LeaseRenewer {
  renewLease(runId: string, leaseId: string, leaseMs: number): Promise<boolean>;
}

/**
 * Run `fn` while heartbeating the lease every ~leaseMs/3 (comfortably inside the
 * lease window). The timer is always cleared, on success or throw. Renewal errors
 * are swallowed: a transient DB blip should not fail the analysis, and a genuine
 * loss of the lease is caught at commit time by the fence.
 */
export async function withLeaseHeartbeat<T>(
  renewer: LeaseRenewer,
  runId: string,
  leaseId: string,
  leaseMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const intervalMs = Math.max(1, Math.floor(leaseMs / 3));
  const timer = setInterval(() => {
    void renewer.renewLease(runId, leaseId, leaseMs).catch(() => {});
  }, intervalMs);
  // Do not keep the process alive solely for the heartbeat.
  if (typeof timer.unref === "function") timer.unref();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}
