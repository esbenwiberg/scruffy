# ADR 0003 validation #7 — language capability record

- **Date:** 2026-07-24
- **Basis:** the walking skeleton as actually built (three gates end-to-end,
  durable Postgres path, gh-CLI + GitHub-App adapters, model adapters, webhook
  server, corpus machinery, ~277 tests) — not the pre-implementation reading
  that informed the original options analysis.

ADR 0003 requires, before acceptance: *"Record any material capability that
would be simpler or safer in Python, C#, or Go."* This is that record, written
with the benefit of having implemented the system in TypeScript. Verdict first:
**nothing found that is material enough to trip a revisit trigger.** Three real
(but non-decisive) advantages elsewhere are recorded honestly below, alongside
the places TypeScript demonstrably earned its keep.

## Capabilities that WOULD be simpler or safer elsewhere

### 1. Child-process adapters would be simpler in Go

The `gh`-CLI and `claude`-CLI adapters cost real scar tissue in Node:
`stdin` EPIPE needs an explicit error listener or the whole process dies
bypassing the gate's abstain discipline; stream chunks must be decoded as UTF-8
per-chunk or a multibyte character split across a chunk boundary corrupts patch
text; timeout-kill-settle interleaving is hand-rolled (`gh-cli.ts` carries all
three fixes). Go's `exec.CommandContext` with `cmd.Output()` gives the same
semantics — deadline, combined error, no partial-decode hazard — in a fraction
of the code. **Materiality: low.** Two adapters, written once, contract-tested;
the hosted path will lean toward Octokit-over-HTTP rather than more
subprocesses.

### 2. The deployment artifact would be smaller and simpler in Go

A Go control plane would ship as one static binary in a distroless image; ours
carries `node_modules`, the Node runtime, and (currently) the `gh` CLI.
Measured cost today: ~68 MiB RSS, 112 ms cold start — three orders of magnitude
inside the latency budget (see `ops-measurement.md`). **Materiality: low** at
<20 repositories; this is an aesthetic advantage, not an operational one.

### 3. Model-provider ecosystem gravity favors Python

New model tooling (SDKs, eval harnesses, structured-output libraries) lands in
Python first. The skeleton's model edge is deliberately thin (adapters behind a
port, schema-parsed hostile output), so this has not bitten — but if scruffy
ever grows heavyweight in-process model tooling (local rerankers, embedding
pipelines), Python's ecosystem would be simpler. **Materiality: low now;
this is exactly ADR 0003's existing revisit trigger about Python-only analysis
dependencies, which stands.**

## Where TypeScript demonstrably earned its keep

- **Exhaustive discriminated unions are load-bearing safety.** Gate routing
  (`run.kind`), decision outcomes, conclusion→state mapping, and backend
  factories all end in `const _exhaustive: never` switches. Adding the release
  gate made the compiler enumerate every place nightly/poison assumptions hid.
  Python's `assert_never` is opt-in convention; C# and Go approximate sum types
  with discipline rather than enforcement.
- **Runtime schemas at every boundary (zod) with inferred static types.** One
  declaration serves both the runtime parse (webhook payloads, persisted outbox
  JSON, GitHub API responses, model output, corpus files) and the compile-time
  type. Pydantic is equivalent; C#/Go need parallel declarations or codegen —
  and the "persisted JSON is untrusted" heritage scar makes this the single
  most-exercised capability in the codebase.
- **Official GitHub tooling.** `@octokit/webhooks-methods` (signature verify),
  `@octokit/auth-app` (App JWT → installation token, transparent refresh) are
  first-party and small. Python/Go equivalents are third-party; C#'s Octokit.NET
  is official but heavier.
- **The async I/O model fits the workload.** The control plane is almost pure
  I/O orchestration; nothing CPU-heavy sits on the event loop (analyzers are
  regex over patches; measured pipeline p50 is 6.5 ms). The known hazard —
  accidental synchronous work blocking the loop — has not materialized and the
  ops instrument would surface it as latency.

## Verdict

Recorded per validation #7: Go's process-exec ergonomics and deployment
artifact, and Python's model-ecosystem gravity, are real but individually and
jointly immaterial at the current scale and architecture. No new revisit
trigger is warranted beyond those already listed in ADR 0003, and no capability
gap found in implementation contradicts the original language selection.
