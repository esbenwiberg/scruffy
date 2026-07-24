# ADR 0003: Implementation stack and initial deployment shape

- **Status:** Proposed
- **Date:** 2026-07-15

## Context

Scruffy needs a GitHub-first control plane that receives webhooks, records immutable evidence, evaluates centrally owned policy, schedules durable work, reconciles missed or out-of-order events, and publishes narrowly authorized effects back to GitHub.

The initial operating context is deliberately small:

- one maintainer;
- fewer than 20 enrolled repositories;
- no incumbent team language preference;
- a greenfield repository with PR Guardian behavioral heritage but no inherited implementation;
- a poison-gate latency target below two minutes p95;
- future Azure DevOps support behind provider adapters;
- repository content and repository-controlled execution treated as hostile.

The initial architecture should optimize for solo delivery, explicit durable contracts, and low operational burden. It should preserve extraction boundaries without paying the cost of distributed services before measured scale, security, or ownership needs justify them.

## Decision

### Implementation language

Use **TypeScript on a supported Node.js LTS release** for the initial control plane and trusted workers.

Use:

- strict TypeScript settings;
- discriminated unions and exhaustive matching for decision and lifecycle states;
- runtime validation at every external, persistence, and worker-message boundary;
- schema-first contract definitions capable of producing JSON Schema;
- stable reason codes rather than free-form decision states;
- an official GitHub client through Octokit;
- direct SQL or a deliberately thin persistence layer whose models do not double as wire or historical evidence contracts.

TypeScript compile-time types are not runtime protection. Untrusted webhook payloads, analyzer output, model output, persisted JSON, and worker messages must be parsed through explicit runtime schemas before entering the domain kernel.

### Deployment shape

Begin as a **modular monolith with separate worker processes**, comprising:

1. **Control-plane process**
   - verifies and ingests GitHub webhooks;
   - exposes the administrative API;
   - resolves immutable subject revisions;
   - loads effective policy;
   - invokes pure gate-decision functions;
   - schedules reconciliation;
   - records intended external effects.

2. **Trusted analysis workers**
   - select and inspect source context without executing repository-controlled commands;
   - invoke deterministic analyzers and model providers under service policy;
   - produce schema-validated evidence;
   - hold no policy-administration authority;
   - do not directly perform GitHub writes.

3. **GitHub effects component**
   - performs idempotent, narrowly authorized GitHub writes;
   - consumes committed outbox records;
   - verifies that effects still target the intended immutable subject;
   - cannot change policy or grant exceptions.

4. **Isolated hostile-execution runner**
   - executes repository-controlled code only when a gate explicitly requires execution;
   - is physically separated from the control plane and trusted workers;
   - initially serves controlled browser/visual QA and any future execution-based analysis;
   - is not used by the poison gate for repository builds or tests.

The modules may share a repository and release artifact initially. Process and credential boundaries are determined by trust, not by whether code shares a repository.

### Durable state and dispatch

Use one **PostgreSQL** database as the initial authoritative state store.

PostgreSQL stores:

- repository enrollment;
- immutable policy versions and assignments;
- evaluation runs and transition history;
- evidence metadata and provenance;
- finding lifecycle state;
- reconciliation cursors and durable watermarks;
- job attempts, leases, and retry state;
- transactional outbox records;
- exception and waiver audit records.

Use a **Postgres-backed durable job queue and transactional outbox** initially. Do not introduce Kafka, Temporal, or another broker/workflow platform until measured workflow complexity, throughput, or operability demonstrates a need.

Handlers and workers must be idempotent. A webhook is a prompt to reconcile durable state, not the authoritative state itself. Job leases must expire safely, retries must be bounded, and duplicate delivery must not duplicate external effects.

Large immutable artifacts such as full diffs, screenshots, traces, and analyzer bundles may move to an object store when their size or retention requirements justify it. PostgreSQL retains their immutable identities, hashes, provenance, and references.

### Domain boundaries

Keep the following modules explicit even while they are deployed together:

- `domain/evaluation`: gate-neutral evaluation-run lifecycle;
- `domain/evidence`: typed evidence, provenance, completeness, and trust level;
- `domain/policy`: immutable effective-policy representation;
- `domain/findings`: semantic identity and lifecycle;
- `gates/poison`: `block | allow | indeterminate` policy evaluation;
- `gates/nightly`: suppress, report, and propose-fix policy evaluation;
- `gates/release`: ship, sign-off-required, stop, and indeterminate evaluation;
- `providers/scm`: GitHub initially and Azure DevOps later;
- `providers/models`: model-provider adapters;
- `providers/analyzers`: language and deterministic-analyzer adapters;
- `persistence`: PostgreSQL repositories, migrations, leases, and outbox;
- `execution`: trusted analysis dispatch and hostile runner protocol;
- `effects`: GitHub checks, comments, and pull-request writes.

Gate decisions should be pure functions over immutable, schema-validated evidence and policy. Network, database, model, and GitHub operations remain outside the decision kernel.

## Isolated hostile-execution runner

The runner is a disposable execution environment for commands or applications controlled by the repository being reviewed. Examples include starting a candidate web application for visual QA, running a repository-provided bootstrap command, or executing a generated proof or test in a future deeper gate.

Merely running the code in a child process or worker thread is not isolation. Repository code can attempt to read credentials, contact cloud metadata services, scan internal networks, consume resources, persist changes, exploit the runtime, or emit malicious artifacts.

Each runner job therefore requires:

- a fresh disposable sandbox, container with an appropriate hardening boundary, microVM, or managed sandbox;
- a dedicated low-privilege service identity;
- no GitHub App private key, policy-administration credential, model-provider secret, production credential, or host socket;
- read-only immutable input plus a bounded writable scratch area;
- default-deny network access with explicit destination allowlists when network access is unavoidable;
- blocked cloud metadata and internal control-plane endpoints;
- non-root execution, dropped capabilities, syscall restrictions, and resource quotas;
- wall-clock timeout and process-count, CPU, memory, disk, and output limits;
- destruction of the environment after every attempt;
- cryptographic identification of inputs and retained outputs;
- logs and artifacts treated as hostile input when returned to Scruffy;
- an authenticated, narrow job/result protocol rather than database or control-plane access.

A container is not automatically a sufficient hostile-code boundary. The required isolation technology must be selected from the threat model and deployment environment. Stronger VM or managed-sandbox isolation may be necessary for arbitrary repository execution.

Trusted analysis workers may parse hostile source text and are still exposed to malformed input and prompt injection, but they do not intentionally execute repository-controlled programs. Their parser, model, filesystem, credential, and egress controls remain necessary; the hostile runner addresses the stronger risk introduced by actual code execution.

## Options considered

### Python, FastAPI, and Pydantic

Python offers the strongest PR Guardian behavioral continuity and a productive runtime-validation and model-integration ecosystem. It was not selected because this repository contains no inherited Python implementation, GitHub's Python clients are third-party, and the async/thread/process topology adds operational choices for a solo maintainer. Python remains a valid reconsideration if reusable Guardian code or Python-only analyzer assets are recovered.

### TypeScript and Node.js

Selected because it combines official GitHub integration, GitHub App frameworks, strong discriminated-union modeling, runtime-schema tooling, and an effective I/O model for webhook and provider orchestration. Its advantages depend on enforcing runtime parsing and keeping CPU-heavy or hostile work outside the event loop.

### C# and .NET

C# provides strong contracts, official GitHub integration, mature PostgreSQL support, and an integrated web/worker host. It was not selected because its additional hosting and dependency-injection machinery does not provide a decisive advantage at the initial scale.

### Go

Go provides the simplest deployment artifact and a strong concurrency model. It was not selected because throughput is not load-bearing below 20 repositories and its runtime-contract, tagged-union, schema, and GitHub integration story requires more custom plumbing.

### Microservices from the outset

Rejected. The initial team and scale do not justify independent service ownership, distributed tracing, cross-service schema deployment, or multiple operational units. Hostile execution is separated immediately because it is a trust boundary, not a scaling optimization.

### Dedicated broker or workflow engine from the outset

Rejected. PostgreSQL leases, reconciliation, and a transactional outbox can meet the initial workload with fewer systems. Reconsider this when workflows require long-lived timers, complex compensation, high fan-out, independent scaling, or operational guarantees that the database-backed mechanism cannot provide cleanly.

## Consequences

### Positive

- Official GitHub tooling reduces integration plumbing.
- Compile-time state modeling and mandatory runtime schemas strengthen evidence and policy contracts.
- One primary database and one codebase fit a solo-maintained deployment.
- Transactional dispatch reduces lost-work and dual-write failure modes.
- Module boundaries allow later extraction without starting as a distributed system.
- The highest-risk execution receives a separate identity and physical boundary immediately.

### Negative

- Runtime schemas and TypeScript types can drift unless one representation is authoritative and checked in CI.
- Node's event loop can be blocked by accidental synchronous or CPU-heavy work.
- PostgreSQL queue semantics, leasing, retry, and reconciliation must be implemented and tested carefully.
- A solo maintainer must still operate a separate hostile-execution environment.
- PR Guardian's Python behavior must be translated rather than reused directly.

## Required validation before acceptance

Before changing this ADR to Accepted:

1. Build a thin GitHub App spike that verifies a webhook and publishes an idempotent check run through Octokit.
2. Model evaluation states, evidence envelopes, policy versions, and reason codes as runtime schemas with exhaustive TypeScript handling.
3. Demonstrate a PostgreSQL transaction that commits an evaluation transition and its outbox effect atomically.
4. Demonstrate lease expiry, duplicate webhook handling, retry, supersession, and reconciliation after process termination.
5. Run one disposable hostile-runner job and prove that it cannot access control-plane credentials, cloud metadata, internal services, or another job's filesystem.
6. Measure cold start, webhook-to-dispatch latency, steady memory, and maintainer-visible operational steps.
7. Record any material capability that would be simpler or safer in Python, C#, or Go before final acceptance.

## Revisit triggers

Revisit the language or deployment shape if:

- reusable PR Guardian Python code materially changes the cost comparison;
- Python-only analysis dependencies become central to the control plane rather than isolated adapters;
- workflow state becomes too complex to implement safely with PostgreSQL jobs and reconciliation;
- throughput, team ownership, or release cadence requires independent service extraction;
- Node event-loop or memory behavior threatens the poison-gate latency target;
- the selected sandbox cannot satisfy the hostile-execution threat model;
- Azure DevOps integration exposes provider assumptions in the domain kernel.

## Amendments

### 2026-07-24 — validation status and recorded deviations

Status remains **Proposed**. Progress against the required validations, with
deviations recorded rather than papered over:

1. **Check-run through Octokit — implemented, outward run pending.** The
   webhook verify path (`@octokit/webhooks-methods`) and an idempotent
   check-run writer authenticated as a GitHub App installation
   (`@octokit/auth-app`; `src/providers/scm/github-app.ts`) exist as
   production-shaped code with offline contract tests, superseding the "thin
   spike". Not yet done: registering an App and publishing a check run against
   a real repository — an operator step. **Deviation:** GitHub *reads* go
   through a `gh`-CLI subprocess adapter rather than Octokit (deliberate for
   local/shadow use: reuses the developer's session, no token in config, and
   fails-closed — every read fault throws so the blocking gate abstains).
   Accepted for development and shadow operation; a hosted deployment should
   read through the App installation as well. This amendment records the
   deviation; the Octokit requirement stands for the hosted path.
2. **Runtime schemas + exhaustive handling — met.** Evaluation states, evidence
   envelopes, policy, reason codes, outbox payloads, and all external responses
   are zod-parsed at their boundaries with exhaustive discriminated-union
   handling in the kernels.
3. **Atomic transition + outbox — met.** `commitDecision` /
   `commitNightlyDecision` / `commitReleaseDecision` commit the terminal
   transition, the decision row, and the outbox effects in one transaction.
4. **Lease expiry, duplicate delivery, retry, supersession, reconciliation —
   met.** Fenced leases with heartbeat, idempotent `ensureRun`, bounded retry
   then abstain, and a reconciler that recovers `pending` and crashed
   `analyzing` runs; exercised by the harness tests.
5. **Hostile-runner isolation proof — outstanding.** The remaining substantive
   blocker to acceptance.
6. **Ops measurement — instrumented and recorded** on a dev machine
   (`npm run ops:measure`; `docs/product/ops-measurement.md`): cold start
   ~112 ms, RSS ~68 MiB, webhook→dispatch p50 6.5 ms. Re-measurement in the
   target environment remains open.
7. **Language capability record — written**:
   `0003-validation-7-language-capability-record.md`. Verdict: no material
   capability gap; no new revisit trigger.

**Deployment-shape deviation:** the walking skeleton runs the control plane,
analysis, and effects dispatch in ONE process (`src/server/main.ts` — HTTP
listener plus reconcile/flush loop) rather than separate worker processes. The
module and credential boundaries the ADR requires are preserved in code
structure (`domain`/`gates`/`providers`/`effects`, writer credential separate
via the App adapter); process separation is deferred until scale or isolation
measurement demands it. The hostile-execution runner remains a hard physical
boundary and is NOT collapsed into this.

## Research basis

The comparison used repository constraints plus current primary documentation for GitHub REST libraries and GitHub Apps, Probot, TypeScript narrowing, runtime schema generation, Node event-loop and child-process behavior, FastAPI and Pydantic, .NET hosting and support policy, Go concurrency and release policy, PostgreSQL drivers, dependency-audit tooling, Docker security guidance, and NIST container-security guidance.
