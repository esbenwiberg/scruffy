-- Leases for crash recovery. When a worker claims a run for analysis it takes a
-- time-bounded lease. If the worker dies mid-analysis the run stays 'analyzing'
-- with an expired lease; the reconciler reclaims it independently of webhook
-- delivery. This is the durable half of ADR 0003 validation #4.

alter table evaluation_runs
  add column lease_owner      text,
  add column lease_expires_at timestamptz;

-- Reconciler lookup: expired 'analyzing' leases (crashed) and stuck 'pending'
-- runs (webhook handler died before claiming).
create index evaluation_runs_reconcile
  on evaluation_runs (state, lease_expires_at)
  where state in ('pending', 'analyzing');
