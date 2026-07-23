-- Fencing token for analysis leases. `lease_owner` is a static per-gate string
-- ("poison-worker"), so it cannot tell two workers of the same gate apart. Each
-- CLAIM mints a fresh `lease_id`; the terminal commit is fenced on it. That
-- closes the zombie-worker hole: a worker whose lease expired and was reclaimed
-- (then re-claimed by another worker with a new token) can no longer land its
-- stale decision over the live worker's — its fence token no longer matches.
alter table evaluation_runs
  add column lease_id text;
