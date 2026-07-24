# Ops measurement — ADR-0003 validation #6

ADR-0003 requires, before acceptance: *"Measure cold start, webhook-to-dispatch
latency, steady memory, and maintainer-visible operational steps."* This
document records the instrument, the methodology and its limits, and measured
runs. Re-run with `npm run ops:measure` (requires `npm run db:up`; it builds
`dist/` first).

## Instrument

`scripts/ops-measure.ts`, two deliberately separated measurements:

1. **Cold start + memory** spawn the real compiled server — `node
   dist/server/main.js`, the exact container command — and time from spawn to
   the first `200 /healthz`, including module load, Postgres connect, and the
   idempotent migration pass. RSS is sampled (`ps`) after boot and again after
   200 requests. 5 runs.
2. **Latency** drives the production `createWebhookServer` code path over a
   real localhost HTTP round trip and the real durable pipeline (ensureRun,
   guarded transitions, analyze, adversarial validate, atomic decision+outbox,
   effects dispatch) with the **SCM edge faked**. 30 runs; p50/p95/max for
   webhook→ack (GitHub's delivery budget) and webhook→dispatch (decision
   committed and effect handed to the SCM writer).

### What this deliberately does NOT measure

- **GitHub API time.** A live run adds the diff read and the check-run/status
  write on top of the pipeline number. That time is GitHub's, varies by diff
  size, and measuring it would fire real writes outward every time someone runs
  the instrument. The shadow review (`npm run scruffy:review`) is the honest
  instrument for end-to-end wall clock against a real PR.
- **Cloud numbers.** A laptop measurement establishes the order of magnitude
  and the methodology. Deployment measurement re-runs this instrument in the
  target environment; the numbers below are NOT that.

## Recorded runs

### 2026-07-24 — Apple Silicon dev laptop (Darwin 25.5.0, Node 22, Postgres in Docker)

| Measure | Result |
| --- | --- |
| Cold start (spawn → healthy, 5 runs) | median **112ms**, max 122ms |
| RSS after boot | **68 MiB** |
| RSS after 200 requests | 69 MiB |
| Webhook → ack (202, run durable) | p50 **0.6ms**, p95 1.5ms, max 6.1ms |
| Webhook → dispatch (full pipeline) | p50 **6.5ms**, p95 11.4ms, max 14.0ms |

Reading: the service's own overhead is negligible against GitHub's ~10s webhook
delivery budget — the ack is three orders of magnitude inside it, and even the
full analyze→decide→dispatch pipeline is two. Cold start well under a second
means crash-and-restart (systemd, container restart policy) is a perfectly
acceptable recovery strategy at this stage; nothing needs to keep warm state.
Memory fits the smallest instance sizes anywhere.

## Maintainer-visible operational steps

The full inventory to stand up and run the service:

1. Provision Postgres and set `DATABASE_URL` (local: `npm run db:up`).
2. Set `SCRUFFY_WEBHOOK_SECRET` (plus writer credentials when using the
   `github-app` writer).
3. Start the service (`npm run serve` / the container `CMD`) — migrations apply
   themselves at boot, serialized by an advisory lock.
4. Point the GitHub webhook at `POST /webhook`; monitor `GET /healthz`.

Everything else — reconcile loop, effect dispatch, crash recovery, bounded
retry, dead-lettering — is self-driving. There is no scheduler, queue broker,
or cache to operate; the operational surface is one process and one database.
