# Hostile-execution runner — local spike (ADR-0003 validation #5, local half)

ADR-0003 requires, before acceptance: *"Run one disposable hostile-runner job
and prove that it cannot access control-plane credentials, cloud metadata,
internal services, or another job's filesystem."*

## What exists

- **Port** (`src/execution/hostile-runner.ts`): a job gets a fresh disposable
  environment, read-only input at `/job`, a bounded scratch tmpfs, resource
  quotas, a wall-clock timeout — and nothing else. Everything a job emits is
  hostile output: bounded, truncation-flagged, never parsed as trusted data.
  `infra_failure` is distinct from a job's own failure so callers abstain on
  runner faults instead of fabricating a verdict.
- **DockerRunner** (`src/execution/docker-runner.ts`): each ADR requirement is
  an explicit engine flag — `--network none` (default-deny, no allowlist path
  exists in the spike at all), `--user 65534`, `--cap-drop ALL`,
  `no-new-privileges`, `--read-only` rootfs, per-job read-only input mount,
  per-container tmpfs scratch, `--memory/--cpus/--pids-limit`, deadline →
  `docker kill` → environment destroyed. No environment variables are ever
  passed in, so control-plane credentials cannot cross by construction — and
  the proof plants them and checks anyway.

## The proof

`test/execution/docker-runner.test.ts` — 12 tests that execute genuinely
hostile jobs and assert the escape FAILS (plus that legitimate use still works,
so the sandbox isn't "secure" by being broken):

| ADR requirement | Hostile probe | Result |
| --- | --- | --- |
| No control-plane credentials | `env` with real credential names planted in the host process; filesystem sweep for keys/sockets | nothing crosses |
| No cloud metadata | `wget http://169.254.169.254/…` | unreachable |
| No internal services | `nc host.docker.internal 5432` (the control plane's own Postgres); interface listing | unreachable; no non-loopback interface |
| No other job's filesystem | job A writes `/scratch/marker`, job B reads it | gone with job A |
| Read-only input / immutable rootfs | `touch /job/…`, `touch /etc/…` | both refused; `/scratch` writes work |
| Disposable + bounded | `sleep 300` under a 2 s cap; 2 MiB output flood under a 4 KiB cap | killed, container verifiably gone; truncated and flagged |
| Hardened identity | `id -u`; job-id/path injection attempts | uid 65534; rejected before the engine sees them |

Run it: `npm run test:isolation` (Docker required, as for the rest of the
suite; `busybox:1.36` is pulled on first run). It is deliberately kept OUT of
the default `npm test`: the proof spins up ~12 real containers and churns
Docker Desktop's VM hard enough to starve the co-located Postgres container,
which would inflate every DB-backed test that ran after it. It is a validation
artifact, not a unit invariant, so it earns its own command.

## What this does NOT prove (the deliberate other half)

The ADR's own warning stands: **a container is not automatically a sufficient
hostile-code boundary.** This spike proves the negative capabilities hold under
Docker's default seccomp/namespace hardening on a dev machine. Still open, and
deployment-environment decisions rather than code:

- selecting the production isolation technology from the threat model
  (gVisor / Kata / microVM / a managed sandbox service) and re-running this
  same proof suite inside it;
- egress allowlists for the (future) jobs that genuinely need network;
- cryptographic identification of inputs and retained outputs;
- the authenticated job/result protocol between the control plane and a
  physically separate runner host (today the spike is a library, in-process
  with its caller — acceptable for a spike, not for production).

The poison gate never uses the runner (it must stay independent of arbitrary
repository execution time); the first real consumer is release visual QA.
